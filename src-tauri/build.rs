fn main() {
    #[cfg(all(feature = "desktop", windows))]
    println!(
        "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595B64144CCF1DF' language='*'"
    );

    #[cfg(feature = "desktop")]
    tauri_build::build();

    #[cfg(feature = "slint-ui")]
    {
        println!("cargo:rerun-if-changed=slint/ui/weighing.slint");
        println!("cargo:rerun-if-changed=slint/assets");
        let config = slint_build::CompilerConfiguration::new()
            .embed_resources(slint_build::EmbedResourcesKind::EmbedFiles);
        slint_build::compile_with_config("slint/ui/weighing.slint", config)
            .expect("failed to compile production Slint UI");
    }
}
