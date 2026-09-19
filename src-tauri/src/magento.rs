use crate::magento_config::{self, Module};
use crate::magento_io::{exec, file_exists, location, read_file};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

const FILE: &str = "magentos.json";
const KEY: &str = "magentos";
pub(crate) const BIN: &str = "bin/magento";
const PHP: &str = "php";
const CONFIG: &str = "app/etc/config.php";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Magento {
    #[serde(default)]
    pub id: String,
    #[serde(alias = "label")]
    pub title: String,
    /// "local" | "ssh"
    pub kind: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    /// Absent means ssh's own default, which `~/.ssh/config` may set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default = "agent")]
    pub auth: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub php: Option<String>,
    #[serde(default)]
    pub version: String,
}

fn agent() -> String {
    "agent".into()
}

fn read<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<Magento>, String> {
    let store = app.store(FILE).map_err(|e| e.to_string())?;
    match store.get(KEY) {
        Some(v) => serde_json::from_value(v).map_err(|e| e.to_string()),
        None => Ok(Vec::new()),
    }
}

fn write<R: Runtime>(app: &AppHandle<R>, list: &[Magento]) -> Result<(), String> {
    let store = app.store(FILE).map_err(|e| e.to_string())?;
    store.set(KEY, serde_json::to_value(list).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())
}

fn find<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<Magento, String> {
    read(app)?
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("unknown magento: {id}"))
}

#[tauri::command]
pub fn magento_list(app: AppHandle) -> Result<Vec<Magento>, String> {
    read(&app)
}

#[tauri::command]
pub fn magento_save(app: AppHandle, magento: Magento) -> Result<Magento, String> {
    let mut saved = magento;
    if saved.id.is_empty() {
        saved.id = format!(
            "m{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );
    }
    let mut list = read(&app)?;
    match list.iter_mut().find(|m| m.id == saved.id) {
        Some(slot) => *slot = saved.clone(),
        None => list.push(saved.clone()),
    }
    write(&app, &list)?;
    Ok(saved)
}

#[tauri::command]
pub fn magento_reorder(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let mut list = read(&app)?;
    list.sort_by_key(|m| ids.iter().position(|id| *id == m.id).unwrap_or(usize::MAX));
    write(&app, &list)
}

#[tauri::command]
pub fn magento_delete(app: AppHandle, id: String) -> Result<(), String> {
    let mut list = read(&app)?;
    list.retain(|m| m.id != id);
    write(&app, &list)
}

fn php(m: &Magento) -> &str {
    m.php
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .unwrap_or(PHP)
}

#[tauri::command]
pub async fn magento_check(magento: Magento) -> Result<(), String> {
    if magento.path.trim().is_empty() {
        return Err("Choose a folder first.".into());
    }
    if file_exists(&magento, BIN)? {
        return Ok(());
    }
    Err(format!(
        "No {BIN} in {} — is this a Magento root?",
        location(&magento, "")
    ))
}

// ---------------------------------------------------------------- modules

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub ok: bool,
    pub command: String,
}

fn check_names(names: &[String]) -> Result<(), String> {
    let bad = |n: &String| !n.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
    match names.iter().find(|n| n.is_empty() || bad(n)) {
        Some(name) => Err(format!("Not a module name: {name}")),
        None => Ok(()),
    }
}

fn subcommand(verb: &str) -> Result<String, String> {
    match verb {
        "enable" | "disable" => Ok(format!("module:{verb}")),
        other => Err(format!("unknown verb: {other}")),
    }
}

fn build_command(php: &str, verb: &str, names: &[String], force: bool) -> Result<String, String> {
    check_names(names)?;
    let flag = if force { " -f" } else { "" };
    Ok(format!(
        "{php} {BIN} {}{flag} {}",
        subcommand(verb)?,
        names.join(" ")
    ))
}

/// Read from etc/config.php for performance
fn modules(m: &Magento) -> Result<Vec<Module>, String> {
    let modules = magento_config::parse(&read_file(m, CONFIG)?);
    if modules.is_empty() {
        return Err(format!("No modules listed in {}", location(m, CONFIG)));
    }
    Ok(modules)
}

fn apply(
    m: &Magento,
    enable: &[String],
    disable: &[String],
    force: bool,
) -> Result<RunResult, String> {
    let mut lines = Vec::new();
    for (verb, names) in [("enable", enable), ("disable", disable)] {
        if !names.is_empty() {
            lines.push(build_command(php(m), verb, names, force)?);
        }
    }
    if lines.is_empty() {
        return Err("No modules given.".into());
    }
    // The lines the confirm dialog showed are the lines that run; joined the
    // way ssh runs them, so a copied history entry pastes as one command.
    let command = lines.join(" && ");
    exec(m, &lines).map_err(|e| format!("{command}\n\n{e}"))?;
    Ok(RunResult { ok: true, command })
}

// ------------------------------------------------------------------ cache

/// What `setup:static-content:deploy` would write, and the LESS it compiles
/// from; `pub/static/.htaccess` stays.
const STATIC: &[&str] = &[
    "pub/static/frontend",
    "pub/static/adminhtml",
    "pub/static/_cache",
    "pub/static/deployed_version.txt",
    "var/view_preprocessed",
];

/// `rm` where `php` runs: a command that hops into a container takes the
/// files with it, and the host may not have them, or may not own them.
fn remove(php: &str, paths: &str) -> String {
    let hop = match php.trim_end().rsplit_once(char::is_whitespace) {
        Some((before, last)) if last.rsplit('/').next().unwrap_or(last).starts_with("php") => before,
        _ => "",
    };
    match hop {
        "" => format!("rm -rf {paths}"),
        hop => format!("{hop} rm -rf {paths}"),
    }
}

fn flush_lines(php: &str, static_content: bool) -> Vec<String> {
    let mut lines = Vec::new();
    if static_content {
        lines.push(remove(php, &STATIC.join(" ")));
    }
    lines.push(remove(php, "var/cache var/page_cache"));
    lines.push(format!("{php} {BIN} cache:flush"));
    lines
}

#[tauri::command]
pub async fn magento_flush(
    app: AppHandle,
    magento_id: String,
    static_content: bool,
) -> Result<RunResult, String> {
    let m = find(&app, &magento_id)?;
    let lines = flush_lines(php(&m), static_content);
    let command = lines.join(" && ");
    exec(&m, &lines).map_err(|e| format!("{command}\n\n{e}"))?;
    Ok(RunResult { ok: true, command })
}

#[tauri::command]
pub async fn module_list(app: AppHandle, magento_id: String) -> Result<Vec<Module>, String> {
    modules(&find(&app, &magento_id)?)
}

#[tauri::command]
pub fn module_command(
    app: AppHandle,
    magento_id: String,
    verb: String,
    names: Vec<String>,
    force: bool,
) -> Result<String, String> {
    let m = find(&app, &magento_id)?;
    build_command(php(&m), &verb, &names, force)
}

#[tauri::command]
pub async fn module_apply(
    app: AppHandle,
    magento_id: String,
    enable: Vec<String>,
    disable: Vec<String>,
    force: bool,
) -> Result<RunResult, String> {
    apply(&find(&app, &magento_id)?, &enable, &disable, force)
}

#[cfg(test)]
mod tests {
    use super::{build_command, flush_lines};

    #[test]
    fn static_content_goes_before_the_cache() {
        assert_eq!(
            flush_lines("php", false),
            ["rm -rf var/cache var/page_cache", "php bin/magento cache:flush"]
        );
        let lines = flush_lines("php", true);
        assert!(lines[0].starts_with("rm -rf pub/static/frontend "));
        assert_eq!(lines[2], "php bin/magento cache:flush");
    }

    #[test]
    fn the_files_are_removed_wherever_php_runs() {
        let first = |php| flush_lines(php, true).remove(0);
        assert!(first("docker compose exec -T phpfpm php")
            .starts_with("docker compose exec -T phpfpm rm -rf pub/static/frontend "));
        // A versioned binary in the container is still php.
        assert!(first("docker compose exec -T phpfpm php8.3")
            .starts_with("docker compose exec -T phpfpm rm -rf "));
        assert!(first("/usr/local/bin/php").starts_with("rm -rf pub/static/frontend "));
    }

    #[test]
    fn rejects_an_unknown_verb() {
        assert!(build_command("php", "nuke", &["A".into()], false).is_err());
        assert_eq!(
            build_command("php", "disable", &["A".into(), "B".into()], false).unwrap(),
            "php bin/magento module:disable A B"
        );
        assert_eq!(
            build_command("php", "enable", &["A".into()], true).unwrap(),
            "php bin/magento module:enable -f A"
        );
    }

    #[test]
    fn refuses_a_name_a_remote_shell_would_read_as_a_command() {
        assert!(build_command("php", "disable", &["A; rm -rf /".into()], false).is_err());
        assert!(build_command("php", "disable", &["Swissup_Breeze".into()], false).is_ok());
    }

    #[test]
    fn the_php_command_can_be_a_whole_container_hop() {
        assert_eq!(
            build_command(
                "docker compose exec -T phpfpm php",
                "enable",
                &["Swissup_Breeze".into()],
                false
            )
            .unwrap(),
            "docker compose exec -T phpfpm php bin/magento module:enable Swissup_Breeze"
        );
    }
}
