use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

pub const INSTALLED: &str = "vendor/composer/installed.json";
pub const APP_CODE: &str = "app/code/*/*/composer.json";

struct Package {
    /// Set for a Magento module this install knows by that name.
    module: Option<String>,
    requires: Vec<String>,
}

/// Composer names are case-insensitive; `require` keys are kept as written.
fn requires(pkg: &Value) -> Vec<String> {
    pkg.get("require")
        .and_then(Value::as_object)
        .map(|o| o.keys().map(|k| k.to_lowercase()).collect())
        .unwrap_or_default()
}

fn name(pkg: &Value) -> Option<String> {
    pkg.get("name").and_then(Value::as_str).map(str::to_lowercase)
}

/// A vendor module's name is not in its composer.json, but its namespace is:
/// `Swissup\Breeze\` autoloads Swissup_Breeze. Only names config.php lists
/// count, so a namespace that does not follow the rule maps to nothing.
fn vendor_module(pkg: &Value, known: &HashMap<String, String>) -> Option<String> {
    pkg.get("autoload")?
        .get("psr-4")?
        .as_object()?
        .keys()
        .map(|ns| ns.trim_matches('\\').replace('\\', "_").to_lowercase())
        .find_map(|n| known.get(&n).cloned())
}

/// Every vendor package from installed.json, v1 (a bare list) or v2.
fn installed(text: &str) -> Vec<Value> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Array(list)) => list,
        Ok(Value::Object(mut o)) => match o.remove("packages") {
            Some(Value::Array(list)) => list,
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// Each module's direct module dependencies, from composer `require`: a
/// package that is not a module (a metapackage, a library) is looked
/// through to what it requires. Vendor wins over app/code for a package
/// both have. Modules with none are left out.
pub fn graph(files: &[(String, String)], modules: &[String]) -> BTreeMap<String, Vec<String>> {
    let known: HashMap<String, String> =
        modules.iter().map(|m| (m.to_lowercase(), m.clone())).collect();
    let mut packages: HashMap<String, Package> = HashMap::new();
    let mut roots: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for (_, text) in files.iter().filter(|(path, _)| path == INSTALLED) {
        for pkg in installed(text) {
            let Some(pkg_name) = name(&pkg) else { continue };
            let is_module = pkg.get("type").and_then(Value::as_str) == Some("magento2-module");
            let module = is_module.then(|| vendor_module(&pkg, &known)).flatten();
            if let Some(m) = &module {
                roots.entry(m.clone()).or_insert_with(|| requires(&pkg));
            }
            packages.insert(pkg_name, Package { module, requires: requires(&pkg) });
        }
    }

    for (path, text) in files.iter().filter(|(path, _)| path.starts_with("app/code/")) {
        // app/code/<Vendor>/<Module>/composer.json
        let parts: Vec<&str> = path.split('/').collect();
        let [_, _, vendor, module, _] = parts[..] else { continue };
        let Some(module) = known.get(&format!("{vendor}_{module}").to_lowercase()).cloned() else {
            continue;
        };
        let Ok(pkg) = serde_json::from_str::<Value>(text) else { continue };
        roots.entry(module.clone()).or_insert_with(|| requires(&pkg));
        if let Some(pkg_name) = name(&pkg) {
            packages
                .entry(pkg_name)
                .or_insert_with(|| Package { module: Some(module), requires: requires(&pkg) });
        }
    }

    roots
        .into_iter()
        .filter_map(|(module, reqs)| {
            let mut found = BTreeSet::new();
            let mut seen = HashSet::new();
            let mut stack = reqs;
            while let Some(req) = stack.pop() {
                if !seen.insert(req.clone()) {
                    continue;
                }
                // Not installed anywhere: php, ext-*, or a package gone missing.
                let Some(pkg) = packages.get(&req) else { continue };
                match &pkg.module {
                    Some(dep) if *dep != module => {
                        found.insert(dep.clone());
                    }
                    Some(_) => {}
                    None => stack.extend(pkg.requires.iter().cloned()),
                }
            }
            (!found.is_empty()).then(|| (module, found.into_iter().collect()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{graph, APP_CODE, INSTALLED};

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    const VENDOR: &str = r#"{"packages": [
        {"name": "swissup/module-breeze", "type": "magento2-module",
         "require": {"php": ">=7.4", "swissup/module-core": "*", "swissup/breeze-meta": "*"},
         "autoload": {"psr-4": {"Swissup\\Breeze\\": ""}}},
        {"name": "swissup/module-core", "type": "magento2-module",
         "require": {"magento/framework": "*"},
         "autoload": {"psr-4": {"Swissup\\Core\\": ""}}},
        {"name": "swissup/breeze-meta", "type": "metapackage",
         "require": {"acme/module-helper": "*"}},
        {"name": "magento/framework", "type": "magento2-library"}
    ]}"#;

    const APP: &str = r#"{"name": "acme/module-helper", "require": {"Swissup/Module-Core": "*"}}"#;

    #[test]
    fn follows_vendor_metapackages_and_app_code() {
        let files = vec![
            (INSTALLED.to_string(), VENDOR.to_string()),
            ("app/code/Acme/Helper/composer.json".to_string(), APP.to_string()),
        ];
        let g = graph(&files, &names(&["Swissup_Breeze", "Swissup_Core", "Acme_Helper"]));
        assert_eq!(g["Swissup_Breeze"], names(&["Acme_Helper", "Swissup_Core"]));
        assert_eq!(g["Acme_Helper"], names(&["Swissup_Core"]), "names are case-insensitive");
        assert!(!g.contains_key("Swissup_Core"), "a library is not a module");
    }

    #[test]
    fn a_module_config_php_does_not_list_is_no_module() {
        let files = vec![(INSTALLED.to_string(), VENDOR.to_string())];
        let g = graph(&files, &names(&["Swissup_Breeze"]));
        assert!(g.is_empty());
        assert!(APP_CODE.starts_with("app/code/"));
    }

    #[test]
    fn reads_the_v1_list() {
        let v1 = r#"[
            {"name": "a/module-a", "type": "magento2-module", "require": {"b/module-b": "*"},
             "autoload": {"psr-4": {"A\\A\\": ""}}},
            {"name": "b/module-b", "type": "magento2-module",
             "autoload": {"psr-4": {"B\\B\\": ""}}}
        ]"#;
        let g = graph(&[(INSTALLED.to_string(), v1.to_string())], &names(&["A_A", "B_B"]));
        assert_eq!(g["A_A"], names(&["B_B"]));
    }
}
