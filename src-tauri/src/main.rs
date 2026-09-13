// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // ssh runs this same binary as its SSH_ASKPASS helper (see
    // `magento::ssh`): print the password it was handed and get out, before
    // anything opens a window.
    if let Ok(password) = std::env::var("MAGEDECK_ASKPASS") {
        println!("{password}");
        return;
    }
    magedeck_lib::run()
}
