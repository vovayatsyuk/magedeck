use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

use crate::magento::Magento;
use crate::ssh;

pub(crate) fn expand(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => match std::env::var_os("HOME") {
            Some(home) => PathBuf::from(home).join(rest),
            None => PathBuf::from(path),
        },
        None => PathBuf::from(path),
    }
}

pub(crate) fn join(path: &str, rel: &str) -> String {
    let path = path.trim().trim_end_matches('/');
    if rel.is_empty() {
        path.to_string()
    } else {
        format!("{path}/{rel}")
    }
}

pub(crate) fn location(m: &Magento, rel: &str) -> String {
    let path = join(&m.path, rel);
    if m.kind == "ssh" {
        format!("{path} on {}", m.host.as_deref().unwrap_or_default())
    } else {
        expand(&path).display().to_string()
    }
}

pub(crate) fn failure_text(out: &Output) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.trim().is_empty() {
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    } else {
        stderr.trim().to_string()
    }
}

pub(crate) fn read_file(m: &Magento, rel: &str) -> Result<String, String> {
    if m.kind == "ssh" {
        return ssh::read_file(m, rel);
    }
    fs::read_to_string(expand(&join(&m.path, rel)))
        .map_err(|e| format!("Could not read {}: {e}", location(m, rel)))
}

pub(crate) fn file_exists(m: &Magento, rel: &str) -> Result<bool, String> {
    if m.kind == "ssh" {
        return ssh::file_exists(m, rel);
    }
    let root = expand(m.path.trim());
    if !root.is_dir() {
        return Err(format!("There is no folder at {}", root.display()));
    }
    Ok(root.join(rel).is_file())
}

pub(crate) fn exec(m: &Magento, lines: &[String]) -> Result<(), String> {
    if m.kind == "ssh" {
        return ssh::exec(m, lines);
    }
    let root = expand(&m.path);
    for line in lines {
        let mut words = line.split_whitespace();
        let program = words.next().ok_or_else(|| "Nothing to run.".to_string())?;
        let out = Command::new(program)
            .args(words)
            .current_dir(&root)
            .output()
            .map_err(|e| format!("Could not run `{program}` in {}: {e}", root.display()))?;
        if !out.status.success() {
            return Err(failure_text(&out));
        }
    }
    Ok(())
}
