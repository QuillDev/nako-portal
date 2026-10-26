fn main() {
    // Declaring the app's commands gives each an `allow-<command>` permission, so the remote
    // portal can be granted `pane_chat` alone.
    let manifest = tauri_build::AppManifest::new().commands(&["start", "connect", "pane", "pane_chat", "pane_search"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)).expect("tauri build");
}
