use std::process::{Command, Output};

use crate::magento::Magento;
use crate::magento_io;

/// The `[user@]host` ssh is given.
fn account(host: &str, user: Option<&str>) -> String {
    match user.map(str::trim).filter(|u| !u.is_empty()) {
        Some(user) => format!("{user}@{host}"),
        None => host.to_string(),
    }
}

/// ssh has no tty here, so it runs this very binary as its askpass helper
/// (see `main`) and reads the secret from its stdout. Batch mode is left off
/// wherever this is used: it would disable the very prompt being answered.
///
/// ponytail: needs OpenSSH 8.4+ (2020) for `SSH_ASKPASS_REQUIRE`. On
/// anything older ssh falls back to asking on a tty there isn't one of, and
/// fails; `sshpass` or a linked ssh library would be the way out.
fn askpass(cmd: &mut Command, secret: &str) -> Result<(), String> {
    cmd.env("MAGEDECK_ASKPASS", secret);
    cmd.env("SSH_ASKPASS_REQUIRE", "force");
    cmd.env(
        "SSH_ASKPASS",
        std::env::current_exe().map_err(|e| format!("Could not find my own binary: {e}"))?,
    );
    Ok(())
}

fn command(m: &Magento, script: &str) -> Result<Command, String> {
    let host = m
        .host
        .as_deref()
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .ok_or_else(|| format!("{} has no SSH host.", m.title))?;
    let user = m.user.as_deref();

    let mut cmd = Command::new("ssh");
    cmd.arg("-o").arg("ConnectTimeout=10");
    if let Some(port) = m.port {
        cmd.arg("-p").arg(port.to_string());
    }
    match m.auth.as_str() {
        "password" => {
            let password = m
                .password
                .as_deref()
                .filter(|p| !p.is_empty())
                .ok_or_else(|| format!("{} has no password.", m.title))?;
            // Only one prompt, so a wrong password fails now rather than
            // after three rounds of the same answer.
            cmd.args(["-o", "NumberOfPasswordPrompts=1"]);
            cmd.args(["-o", "PubkeyAuthentication=no"]);
            askpass(&mut cmd, password)?;
        }
        "key" => {
            let key = m
                .key_path
                .as_deref()
                .map(str::trim)
                .filter(|k| !k.is_empty())
                .ok_or_else(|| format!("{} has no key file.", m.title))?;
            // ssh only warns about a key file it cannot read and then fails
            // with a bare "Permission denied (publickey)", which says
            // nothing about the typo that caused it.
            if !magento_io::expand(key).is_file() {
                return Err(format!("There is no key file at {key}"));
            }
            // IdentitiesOnly: without it ssh offers the agent's keys first
            // and the chosen file may never be tried.
            cmd.args(["-o", "IdentitiesOnly=yes"]);
            // The key is the only thing to try. Without this, a passphrase
            // ssh could not use would be offered to the server as an account
            // password on the next attempt.
            cmd.args(["-o", "PasswordAuthentication=no"]);
            cmd.args(["-o", "KbdInteractiveAuthentication=no"]);
            cmd.arg("-i").arg(magento_io::expand(key));
            match m.password.as_deref().filter(|p| !p.is_empty()) {
                // An encrypted key has to be asked about, and batch mode
                // would refuse to ask.
                Some(passphrase) => askpass(&mut cmd, passphrase)?,
                None => {
                    cmd.args(["-o", "BatchMode=yes"]);
                }
            }
        }
        // The agent, plus whatever `~/.ssh/config` says for this host.
        // BatchMode keeps ssh from sitting forever on a prompt with no tty
        // to answer it; a key the agent does not hold fails right away.
        _ => {
            cmd.args(["-o", "BatchMode=yes"]);
        }
    }
    cmd.arg(account(host, user)).arg(script);
    Ok(cmd)
}

fn output(m: &Magento, script: &str) -> Result<Output, String> {
    command(m, script)?
        .output()
        .map_err(|e| format!("Could not run `ssh`: {e}"))
}

fn remote(path: &str) -> String {
    let quote = |s: &str| format!("'{}'", s.replace('\'', r"'\''"));
    match path.strip_prefix("~/") {
        Some(rest) => format!("~/{}", quote(rest)),
        None => quote(path),
    }
}

fn remote_join(path: &str, rel: &str) -> String {
    remote(&magento_io::join(path, rel))
}

pub(crate) fn read_file(m: &Magento, rel: &str) -> Result<String, String> {
    let out = output(m, &format!("cat {}", remote_join(&m.path, rel)))?;
    if !out.status.success() {
        return Err(format!(
            "Could not read {}: {}",
            magento_io::location(m, rel),
            magento_io::failure_text(&out)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub(crate) fn file_exists(m: &Magento, rel: &str) -> Result<bool, String> {
    let out = output(m, &format!("test -f {}", remote_join(&m.path, rel)))?;
    match out.status.code() {
        Some(0) => Ok(true),
        // 255 (and a signal) are ssh's own; any other code came from `test`.
        Some(255) | None => Err(format!(
            "Could not reach {}: {}",
            m.host.as_deref().unwrap_or_default(),
            magento_io::failure_text(&out)
        )),
        Some(_) => Ok(false),
    }
}

pub(crate) fn exec(m: &Magento, lines: &[String]) -> Result<(), String> {
    let script = format!("cd {} && {}", remote(&m.path), lines.join(" && "));
    let out = output(m, &script)?;
    if out.status.success() {
        Ok(())
    } else {
        Err(magento_io::failure_text(&out))
    }
}

#[cfg(test)]
mod tests {
    use super::remote_join;

    #[test]
    fn quotes_a_remote_path_but_leaves_the_tilde_to_the_shell() {
        assert_eq!(
            remote_join("/var/www/my store/", "bin/magento"),
            "'/var/www/my store/bin/magento'"
        );
        assert_eq!(remote_join("~/sites/store", "bin/magento"), "~/'sites/store/bin/magento'");
    }
}
