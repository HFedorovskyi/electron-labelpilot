fn main() {
    let config = slint_build::CompilerConfiguration::new()
        .embed_resources(slint_build::EmbedResourcesKind::EmbedFiles);
    slint_build::compile_with_config("../../src-tauri/slint/ui/weighing.slint", config)
        .expect("failed to compile production Slint UI");
}
