// skia-bindings does not pull these in on Windows, but Skia's ICU integration
// needs advapi32 (registry, for Windows time-zone detection) and skia's font
// backend wants a few more.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        for lib in ["advapi32", "shell32", "oleaut32", "version"] {
            println!("cargo:rustc-link-lib=dylib={lib}");
        }
    }
}
