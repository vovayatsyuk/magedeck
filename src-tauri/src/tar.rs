//! Just enough of tar to read what `tar cf -` writes for a handful of small
//! text files: GNU, ustar or pax, regular files only.

const BLOCK: usize = 512;

fn field(header: &[u8], at: usize, len: usize) -> &[u8] {
    let raw = &header[at..at + len];
    let end = raw.iter().position(|&b| b == 0).unwrap_or(len);
    &raw[..end]
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn octal(bytes: &[u8]) -> Result<usize, String> {
    let s = std::str::from_utf8(bytes).map_err(|_| "tar: bad size field")?.trim();
    usize::from_str_radix(if s.is_empty() { "0" } else { s }, 8)
        .map_err(|_| format!("tar: bad size field {s:?}"))
}

/// A pax header's `path=` record: `"<len> path=<value>\n"`, one per line.
fn pax_path(data: &[u8]) -> Option<String> {
    text(data).lines().find_map(|line| {
        let (_, record) = line.split_once(' ')?;
        record.strip_prefix("path=").map(str::to_string)
    })
}

/// Each regular file as its path and its contents.
pub fn read(archive: &[u8]) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    let mut at = 0;
    // A GNU `L` or pax `x` entry names the file that follows it.
    let mut long_name: Option<String> = None;
    while at + BLOCK <= archive.len() {
        let header = &archive[at..at + BLOCK];
        // The archive ends in zero blocks.
        if header.iter().all(|&b| b == 0) {
            break;
        }
        let size = octal(field(header, 124, 12))?;
        let start = at + BLOCK;
        let data = archive
            .get(start..start + size)
            .ok_or("tar: the archive is cut short")?;
        at = start + size.div_ceil(BLOCK) * BLOCK;

        match header[156] {
            b'L' => long_name = Some(text(field(data, 0, data.len()))),
            b'x' => long_name = pax_path(data).or(long_name),
            b'0' | 0 => {
                let name = long_name.take().unwrap_or_else(|| {
                    let name = text(field(header, 0, 100));
                    // POSIX ustar splits a long path; old GNU uses these bytes
                    // for something else and has its own magic.
                    let prefix = field(header, 345, 155);
                    if &header[257..263] == b"ustar\0" && !prefix.is_empty() {
                        format!("{}/{name}", text(prefix))
                    } else {
                        name
                    }
                });
                out.push((name, text(data)));
            }
            _ => long_name = None,
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::read;
    use std::process::Command;

    /// Built by the real tar, in the formats a server's tar may default to.
    /// `a|b` names one format both ways: bsdtar's `gnutar` is GNU tar's `gnu`.
    fn archive(dir: &std::path::Path, format: &str) -> Vec<u8> {
        for name in format.split('|') {
            let out = Command::new("tar")
                .env("COPYFILE_DISABLE", "1")
                .args(["cf", "-", "--format", name, "a.json", "app/code/Acme/Very"])
                .current_dir(dir)
                .output()
                .unwrap();
            if out.status.success() {
                return out.stdout;
            }
        }
        panic!("tar knows no format {format}");
    }

    #[test]
    fn reads_what_tar_writes() {
        let dir = std::env::temp_dir().join(format!("magedeck-tar-{}", std::process::id()));
        let deep = format!("app/code/Acme/Very{}", "/Long".repeat(25));
        std::fs::create_dir_all(dir.join(&deep)).unwrap();
        std::fs::write(dir.join("a.json"), "{\"a\": 1}").unwrap();
        std::fs::write(dir.join(&deep).join("composer.json"), "x".repeat(700)).unwrap();

        for format in ["ustar", "pax", "gnutar|gnu"] {
            let bytes = archive(&dir, format);
            let files: Vec<_> = read(&bytes).unwrap().into_iter().filter(|(p, _)| !p.ends_with('/')).collect();
            assert_eq!(files[0], ("a.json".to_string(), "{\"a\": 1}".to_string()), "{format}");
            let long = files.iter().find(|(p, _)| p.ends_with("composer.json"));
            // ustar cannot hold a path this long unless it splits cleanly.
            if let Some((path, body)) = long {
                assert_eq!(path, &format!("{deep}/composer.json"), "{format}");
                assert_eq!(body.len(), 700, "{format}");
            } else {
                assert_eq!(format, "ustar");
            }
        }
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn refuses_a_cut_archive() {
        let mut header = vec![0u8; 512];
        header[..6].copy_from_slice(b"a.json");
        header[124..135].copy_from_slice(b"00000001000");
        header[156] = b'0';
        assert!(read(&header).is_err());
        assert!(read(&[]).unwrap().is_empty());
    }
}
