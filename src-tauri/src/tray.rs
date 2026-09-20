use serde::Deserialize;
use std::sync::Mutex;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Runtime};

const ID: &str = "main";
const SHOW: &str = "show";
const QUIT: &str = "quit";
/// Prefixes a preset's id in the menu; the rest goes back to the frontend.
const PRESET: &str = "preset:";
const FLUSH_CACHE: &str = "flush:cache";
const FLUSH_STATIC: &str = "flush:static";
const FLUSHES: [(&str, &str); 2] = [
    (FLUSH_CACHE, "Flush cache"),
    (FLUSH_STATIC, "Flush cache and static content"),
];
/// Stands in for the install's title until there is one.
const NAME: &str = "MageDeck";

#[derive(Deserialize)]
pub struct Preset {
    id: String,
    name: String,
    /// Applying it would change nothing.
    applied: bool,
    #[serde(default)]
    applying: bool,
}

fn icon() -> Image<'static> {
    #[cfg(not(target_os = "windows"))]
    return tauri::include_image!("icons/tray.png");
    #[cfg(target_os = "windows")]
    return taskbar::icon();
}


/// macOS lists an app in ⌘Tab only while it has a Dock icon, so an app in
/// the tray gives up both, and takes them back as it comes out. Under
/// `tauri dev` the Dock never takes the icon back: that binary has no bundle.
#[cfg(target_os = "macos")]
fn in_dock<R: Runtime>(app: &AppHandle<R>, yes: bool) {
    use tauri::ActivationPolicy::{Accessory, Regular};
    let _ = app.set_activation_policy(if yes { Regular } else { Accessory });
}

pub fn show<R: Runtime>(app: &AppHandle<R>) {
    // First, or the window comes up without focus.
    #[cfg(target_os = "macos")]
    in_dock(app, true);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    // The install may have been changed from a terminal while the window was
    // away, so the modules are re-read as it comes back.
    let _ = app.emit("tray-shown", ());
}

pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    #[cfg(target_os = "macos")]
    in_dock(app, false);
}

/// The items whose label or tick changes, in menu order, kept so an update
/// writes to the menu the tray already has: `set_menu` hands it another one,
/// which a menu open on screen goes on ignoring until it is reopened.
struct Items<R: Runtime> {
    title: MenuItem<R>,
    /// With each preset's id, to tell a relabelling from a different set.
    presets: Vec<(String, CheckMenuItem<R>)>,
    /// Empty without an install to run them in.
    flushes: Vec<MenuItem<R>>,
}

impl<R: Runtime> Items<R> {
    /// True while the menu holds these presets, in this order, and its flushes
    /// belong there: then labels and ticks are all that is left to write.
    fn fit(&self, title: Option<&str>, presets: &[Preset]) -> bool {
        self.flushes.is_empty() == title.is_none()
            && self.presets.len() == presets.len()
            && self.presets.iter().zip(presets).all(|((id, _), p)| *id == p.id)
    }

    fn update(
        &self,
        title: Option<&str>,
        presets: &[Preset],
        flushing: Option<&str>,
    ) -> tauri::Result<()> {
        self.title.set_text(title.unwrap_or(NAME))?;
        for ((_, item), p) in self.presets.iter().zip(presets) {
            item.set_text(preset_label(p))?;
            item.set_checked(p.applied)?;
        }
        for ((id, label), item) in FLUSHES.iter().zip(&self.flushes) {
            item.set_text(flush_label(id, label, flushing))?;
        }
        Ok(())
    }
}

/// The items of the menu the tray icon is carrying.
struct Live<R: Runtime>(Mutex<Items<R>>);

fn preset_label(p: &Preset) -> String {
    if p.applying {
        format!("{} (applying…)", p.name)
    } else {
        p.name.clone()
    }
}

fn flush_label(id: &str, label: &str, flushing: Option<&str>) -> String {
    if flushing == id.strip_prefix("flush:") {
        format!("{label} (flushing…)")
    } else {
        label.to_string()
    }
}

fn menu<R: Runtime>(
    app: &AppHandle<R>,
    title: Option<&str>,
    presets: &[Preset],
    flushing: Option<&str>,
) -> tauri::Result<(Menu<R>, Items<R>)> {
    let title_item = MenuItem::with_id(app, SHOW, title.unwrap_or(NAME), true, None::<&str>)?;
    let mut items: Vec<Box<dyn IsMenuItem<R>>> = vec![
        Box::new(title_item.clone()),
        Box::new(PredefinedMenuItem::separator(app)?),
    ];
    let mut presets_items = Vec::new();
    if !presets.is_empty() {
        for p in presets {
            let id = format!("{PRESET}{}", p.id);
            let item =
                CheckMenuItem::with_id(app, id, preset_label(p), true, p.applied, None::<&str>)?;
            items.push(Box::new(item.clone()));
            presets_items.push((p.id.clone(), item));
        }
        items.push(Box::new(PredefinedMenuItem::separator(app)?));
    }
    let mut flushes = Vec::new();
    // Only with an install to run them in.
    if title.is_some() {
        for (id, label) in FLUSHES {
            let label = flush_label(id, label, flushing);
            let item = MenuItem::with_id(app, id, label, true, None::<&str>)?;
            items.push(Box::new(item.clone()));
            flushes.push(item);
        }
        items.push(Box::new(PredefinedMenuItem::separator(app)?));
    }
    items.push(Box::new(MenuItem::with_id(app, QUIT, "Quit", true, Some("CmdOrCtrl+Q"))?));
    let refs: Vec<&dyn IsMenuItem<R>> = items.iter().map(|i| i.as_ref()).collect();
    let menu = Menu::with_items(app, &refs)?;
    Ok((menu, Items { title: title_item, presets: presets_items, flushes }))
}

pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let (menu, items) = menu(app, None, &[], None)?;
    app.manage(Live(Mutex::new(items)));
    let builder = TrayIconBuilder::with_id(ID)
        .tooltip(NAME)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            SHOW => show(app),
            QUIT => app.exit(0),
            FLUSH_CACHE => {
                let _ = app.emit("tray-flush", false);
            }
            FLUSH_STATIC => {
                let _ = app.emit("tray-flush", true);
            }
            id => {
                if let Some(preset) = id.strip_prefix(PRESET) {
                    let _ = app.emit("tray-preset", preset);
                }
            }
        });

    let _tray = builder.icon(icon()).icon_as_template(true).build(app)?;
    #[cfg(target_os = "windows")]
    taskbar::watch(move || {
        let _ = _tray.set_icon(Some(icon()));
    });
    Ok(())
}

#[tauri::command]
pub fn tray_menu<R: Runtime>(
    app: AppHandle<R>,
    title: Option<String>,
    presets: Vec<Preset>,
    // "cache" or "static" while one of those runs.
    flushing: Option<String>,
) -> Result<(), String> {
    let (title, flushing) = (title.as_deref(), flushing.as_deref());
    let live = app.state::<Live<R>>();
    let mut live = live.0.lock().map_err(|e| e.to_string())?;
    // Only a different set of items needs a menu of its own.
    if live.fit(title, &presets) {
        return live.update(title, &presets, flushing).map_err(|e| e.to_string());
    }
    let tray = app.tray_by_id(ID).ok_or("The tray icon is missing.")?;
    let (menu, items) = menu(&app, title, &presets, flushing).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    *live = items;
    Ok(())
}

#[tauri::command]
pub fn tray_show<R: Runtime>(app: AppHandle<R>) {
    show(&app);
}

/// The Windows taskbar follows the "Windows mode" setting, which can be light
/// while apps are dark, so it is read on its own.
#[cfg(target_os = "windows")]
mod taskbar {
    use std::ptr::null_mut;
    use tauri::image::Image;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegGetValueW, RegNotifyChangeKeyValue, RegOpenKeyExW, HKEY,
        HKEY_CURRENT_USER, KEY_NOTIFY, REG_NOTIFY_CHANGE_LAST_SET, RRF_RT_REG_DWORD,
    };

    const KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    /// Dark when the setting cannot be read: that is what Windows 10 and 11
    /// ship with.
    fn light() -> bool {
        let mut value: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                wide(KEY).as_ptr(),
                wide("SystemUsesLightTheme").as_ptr(),
                RRF_RT_REG_DWORD,
                null_mut(),
                (&mut value as *mut u32).cast(),
                &mut size,
            )
        };
        status == ERROR_SUCCESS && value == 1
    }

    pub fn icon() -> Image<'static> {
        if light() {
            tauri::include_image!("icons/tray-black.png")
        } else {
            tauri::include_image!("icons/tray.png")
        }
    }

    /// Calls `f`, on a thread of its own, each time a value under the key is
    /// written: the switch in Settings writes one.
    pub fn watch(f: impl Fn() + Send + 'static) {
        std::thread::spawn(move || unsafe {
            let mut key: HKEY = null_mut();
            if RegOpenKeyExW(HKEY_CURRENT_USER, wide(KEY).as_ptr(), 0, KEY_NOTIFY, &mut key)
                != ERROR_SUCCESS
            {
                return;
            }
            // Blocks until the next change; each call watches for one.
            while RegNotifyChangeKeyValue(key, 0, REG_NOTIFY_CHANGE_LAST_SET, null_mut(), 0)
                == ERROR_SUCCESS
            {
                f();
            }
            RegCloseKey(key);
        });
    }
}
