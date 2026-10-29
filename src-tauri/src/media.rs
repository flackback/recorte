//! The page's camera and microphone belong to the app: WebView2 never asks for them.

use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{Manager, Runtime, Webview, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Profile4, ICoreWebView2_13, COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
    COREWEBVIEW2_PERMISSION_STATE_ALLOW,
};
use webview2_com::SetPermissionStateCompletedHandler;
use windows::core::{Interface, HSTRING};

/// Answers WebView2's prompt: the app's own pages get the camera and microphone; any other page,
/// and any other permission, is asked as usual.
pub fn on_request<R: Runtime>(webview: Webview<R>, kind: PermissionKind) -> PermissionResponse {
    let own = webview.url().is_ok_and(|url| match url.scheme() {
        "tauri" => true,
        // Built pages come from tauri.localhost; in development, from the dev server here.
        "http" | "https" => matches!(url.host_str(), Some("tauri.localhost" | "localhost" | "127.0.0.1")),
        _ => false,
    });
    match kind {
        PermissionKind::Camera | PermissionKind::Microphone if own => PermissionResponse::Allow,
        _ => PermissionResponse::Default,
    }
}

/// A choice saved earlier wins over `on_request`, so a "Block" clicked once would keep the webcam
/// off for good. This saves "Allow" over it for the app's origin.
pub fn allow_saved<R: Runtime>(window: &WebviewWindow<R>) {
    // The window is still blank at startup, so the origin comes from the configuration.
    let origin = match window.config().build.dev_url.as_ref().filter(|_| tauri::is_dev()) {
        Some(url) => url.origin().ascii_serialization(),
        // Built pages come from Tauri's own protocol, served on Windows under this origin.
        None => "http://tauri.localhost".to_string(),
    };
    let origin = HSTRING::from(origin);
    let result = window.with_webview(move |webview| {
        let result = (|| -> windows::core::Result<()> {
            let profile = unsafe { webview.controller().CoreWebView2()? }
                .cast::<ICoreWebView2_13>()
                .and_then(|core| unsafe { core.Profile() })?
                .cast::<ICoreWebView2Profile4>()?;
            for kind in [COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE] {
                let done = SetPermissionStateCompletedHandler::create(Box::new(|_| Ok(())));
                unsafe { profile.SetPermissionState(kind, &origin, COREWEBVIEW2_PERMISSION_STATE_ALLOW, &done)? };
            }
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("permissão da câmera e do microfone não salva: {error}");
        }
    });
    if let Err(error) = result {
        eprintln!("permissão da câmera e do microfone não salva: {error}");
    }
}
