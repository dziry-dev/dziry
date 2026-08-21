// `skia-bindings` does not pull these in on Windows, and without `advapi32` you
// get unresolved `__imp_Reg*` from Skia's ICU time-zone code. Same list as
// `native-src/skia-probe/build.rs`, which is where it was worked out.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        for lib in ["advapi32", "shell32", "oleaut32", "version"] {
            println!("cargo:rustc-link-lib=dylib={lib}");
        }
    }
}
