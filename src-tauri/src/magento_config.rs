use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Module {
    pub name: String,
    pub vendor: String,
    pub on: bool,
}

/// Magento writes this file itself, one `'Name' => 0|1,` per line
/// A hand-minified config.php parses as empty for visible error;
pub fn parse(src: &str) -> Vec<Module> {
    let mut out = Vec::new();
    let mut inside = false;
    for line in src.lines() {
        let line = line.trim();
        if !inside {
            inside = line.starts_with("'modules'") || line.starts_with("\"modules\"");
            continue;
        }
        if line.starts_with(']') {
            break;
        }
        let Some((name, value)) = line.split_once("=>") else {
            continue;
        };
        let name = name.trim().trim_matches(['\'', '"']);
        let on = value.trim().trim_end_matches(',').trim() == "1";
        if name.is_empty() {
            continue;
        }
        let vendor = name.split('_').next().unwrap_or(name).to_string();
        out.push(Module {
            name: name.to_string(),
            vendor,
            on,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::parse;

    const SAMPLE: &str = r#"<?php
return [
    'backend' => [
        'frontName' => 'admin'
    ],
    'modules' => [
        'Magento_Store' => 1,
        'Swissup_Breeze' => 0,
        'Amasty_Base' => 1
    ],
    'system' => [
        'default' => []
    ]
];
"#;

    #[test]
    fn reads_names_flags_and_vendor() {
        let got = parse(SAMPLE);
        assert_eq!(got.len(), 3, "stops at the end of the modules section");
        assert_eq!(got[0].name, "Magento_Store");
        assert_eq!(got[0].vendor, "Magento");
        assert!(got[0].on);
        assert!(!got[1].on, "0 means disabled");
    }

    #[test]
    fn no_modules_section_yields_nothing() {
        assert!(parse("<?php\nreturn ['backend' => []];\n").is_empty());
    }
}
