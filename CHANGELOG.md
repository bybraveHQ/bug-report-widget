# Changelog

## 0.4.0

- **Breaking:** screen recording removed — the `video` option, `data-video` attribute and the `video.webm` report field are gone; recording could not survive host page reloads without a companion window, so the feature was dropped

## 0.3.0

- Screen recording is enabled by default; `video: false` (`data-video="false"`) hides the record button
- `position` option (`data-position`): initial button position — edge/corner preset or `{ x, y }`
- Custom hotkey: `hotkey: 'k'` (`data-hotkey="k"`) remaps Cmd/Ctrl+B to another letter/digit
- `onSubmit` / `onError` callbacks for host-side toasts and analytics
- `screenshotQuality` option (`data-screenshot-quality`): screenshot JPEG quality, 0–1

## 0.2.0

- Screen recording (opt-in `video: true`, max 60s, source/microphone settings, red frame + timer)
- Report destination picker: POST to endpoint or download as .zip (no backend required)
- Network capture: `network: 'all'` mode, `XMLHttpRequest` support, request/response headers and bodies, sensitive header redaction
- Console capture: failed resource loads (broken images/scripts/styles)
- Annotation colors follow the report type
- Text size stepper: press and hold to change the value continuously
- `download: false` option (`data-download="false"`) hides the Download destination, reports go to the endpoint only

## 0.1.5

- Screenshot sent as JPEG to cut payload size
- Shorter post-send linger, calmer "sent" label

## 0.1.4

- Screenshot capture switched to snapdom (faster)

## 0.1.3

- Console format specifiers (`%s`, `%o`, ...) resolved when serializing logs
- Auto-init guarded for SSR environments (Next.js and friends)
- Package renamed to the `@bybrave` scope

## 0.1.0

- Initial release: floating button, screenshot, annotations (rect / arrow / pencil / text), console error and failed request capture, POST to endpoint
