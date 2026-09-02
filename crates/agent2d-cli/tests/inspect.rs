use assert_cmd::Command;
use image::{ImageFormat, Rgb, RgbImage};
use serde_json::Value;
use tempfile::tempdir;

#[test]
fn inspect_command_returns_stable_json_contract() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("sample.png");
    RgbImage::from_pixel(4, 3, Rgb([12, 34, 56]))
        .save_with_format(&path, ImageFormat::Png)
        .unwrap();

    let output = Command::cargo_bin("agent2d")
        .unwrap()
        .arg("inspect")
        .arg(&path)
        .output()
        .unwrap();

    assert!(output.status.success());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["schemaVersion"], "0.1");
    assert_eq!(value["ok"], true);
    assert_eq!(value["data"]["format"], "png");
    assert_eq!(value["data"]["width"], 4);
    assert_eq!(value["data"]["height"], 3);
    assert_eq!(value["data"]["hasAlpha"], false);
}

#[test]
fn inspect_command_emits_machine_readable_error() {
    let output = Command::cargo_bin("agent2d")
        .unwrap()
        .arg("inspect")
        .arg("/definitely/missing/agent2d.png")
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(2));
    let value: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(value["schemaVersion"], "0.1");
    assert_eq!(value["ok"], false);
    assert_eq!(value["error"]["code"], "input_not_found");
}
