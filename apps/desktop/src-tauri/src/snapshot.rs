//! A pick's crop: `WebKit`'s own snapshot of what it painted in a box of the preview (Pick on Page spec §6).
//!
//! Taken by the shell, not the page, so nothing extra runs in the page and cross-origin images and fonts
//! come out as drawn. The box is padded, clamped to the view, and scaled so its long side is at most
//! `LONG_SIDE_MAX` pixels.

use std::sync::mpsc;
use std::time::Duration;

use crate::pick_rules::Rect;

/// CSS pixels of the page kept around the picked box.
const PAD: f64 = 24.0;
/// The longest side of a crop, in pixels.
const LONG_SIDE_MAX: f64 = 1600.0;
/// How long the shell waits for `WebKit`'s snapshot.
const WAIT: Duration = Duration::from_secs(5);

/// `rect` padded and clamped to a `width` by `height` view; `None` when nothing of it is in view.
pub fn crop_box(rect: Rect, width: f64, height: f64) -> Option<Rect> {
    let x = (rect.x - PAD).max(0.0);
    let y = (rect.y - PAD).max(0.0);
    let right = (rect.x + rect.width + PAD).min(width);
    let bottom = (rect.y + rect.height + PAD).min(height);
    (right - x >= 1.0 && bottom - y >= 1.0).then_some(Rect {
        x,
        y,
        width: right - x,
        height: bottom - y,
    })
}

/// The crop of `rect` as PNG bytes, or `None` when `WebKit` gave none in time.
pub fn take<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    rect: Rect,
    dpr: f64,
) -> Option<Vec<u8>> {
    let (send, receive) = mpsc::channel::<Option<Vec<u8>>>();
    webview
        .with_webview(move |platform| platform_snapshot(&platform, rect, dpr, send))
        .ok()?;
    receive.recv_timeout(WAIT).ok().flatten()
}

#[cfg(target_os = "macos")]
// The shell's AppKit and WebKit calls for a snapshot: each is unsafe only because objc2 cannot check
// the Objective-C types across the boundary; the pointers come from wry's live WKWebView.
#[allow(unsafe_code)]
fn platform_snapshot(
    platform: &tauri::webview::PlatformWebview,
    rect: Rect,
    dpr: f64,
    send: mpsc::Sender<Option<Vec<u8>>>,
) {
    use block2::RcBlock;
    use objc2_app_kit::NSImage;
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{NSError, NSNumber};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

    let Some(main_thread) = objc2::MainThreadMarker::new() else {
        let _ = send.send(None);
        return;
    };
    // SAFETY: wry's `inner` is its retained WKWebView, alive for as long as the webview is.
    let view: &WKWebView = unsafe { &*platform.inner().cast::<WKWebView>() };
    let bounds = view.bounds();
    let Some(crop) = crop_box(rect, bounds.size.width, bounds.size.height) else {
        let _ = send.send(None);
        return;
    };
    let config = unsafe { WKSnapshotConfiguration::new(main_thread) };
    let long = crop.width.max(crop.height) * dpr.max(1.0);
    unsafe {
        config.setRect(CGRect::new(
            CGPoint::new(crop.x, crop.y),
            CGSize::new(crop.width, crop.height),
        ));
        if long > LONG_SIDE_MAX {
            // The snapshot's width is in points; the image's pixels follow the screen's scale.
            let width = NSNumber::new_f64(crop.width * LONG_SIDE_MAX / long);
            config.setSnapshotWidth(Some(&width));
        }
    }
    let done = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
        let png = (!image.is_null()).then(|| {
            // SAFETY: WebKit hands a live image for the length of the callback.
            let image: &NSImage = unsafe { &*image };
            png_bytes(image)
        });
        let _ = send.send(png.flatten());
    });
    unsafe { view.takeSnapshotWithConfiguration_completionHandler(Some(&config), &done) };
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
fn png_bytes(image: &objc2_app_kit::NSImage) -> Option<Vec<u8>> {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::NSDictionary;

    let tiff = image.TIFFRepresentation()?;
    let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
    let properties = NSDictionary::new();
    // SAFETY: an empty property dictionary is a valid argument for any file type.
    let data =
        unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties) }?;
    Some(data.to_vec())
}

#[cfg(not(target_os = "macos"))]
fn platform_snapshot(
    _platform: &tauri::webview::PlatformWebview,
    _rect: Rect,
    _dpr: f64,
    send: mpsc::Sender<Option<Vec<u8>>>,
) {
    let _ = send.send(None);
}
