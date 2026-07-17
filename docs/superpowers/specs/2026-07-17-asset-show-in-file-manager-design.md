# Asset Show in File Manager Design

## Goal

Add a context-menu action to each Assets sidebar row that reveals the asset file in the host operating system's file manager. The action must work when the application is running locally on macOS or Windows and must be hidden for remote deployments and unsupported operating systems.

## User Interaction

- Right-clicking an asset row, including a trackpad two-finger click, opens a context menu.
- The menu contains the existing asset actions and a platform-specific reveal action:
  - macOS: `Show in Finder`
  - Windows: `Show in File Explorer`
- `Copy URL` and `Delete` remain available in the context menu and through the existing hover buttons.
- A successful reveal closes the menu without additional UI.
- A missing file or launch failure produces a short inline error message associated with the affected asset.
- The reveal action is not rendered when the application is accessed through a non-loopback hostname or when the server platform is unsupported.

## Architecture

### Capability endpoint

Create a server endpoint that reports whether file-manager reveal is available for the current request. Availability requires both:

1. The request hostname is `localhost`, `127.0.0.1`, or `::1`.
2. `process.platform` is `darwin` or `win32`.

The response includes a platform-specific menu label. The sidebar requests this capability when the Assets tab is opened and hides the action unless the endpoint explicitly reports it as available.

### Reveal endpoint

The reveal request accepts an asset ID, not a filesystem path or arbitrary URL. The server reads the asset-library index, finds the matching entry, resolves its stored `fileUrl`, and validates that the resulting file belongs to an allowed project-managed storage root. The endpoint also repeats the loopback-host and supported-platform checks so that hiding the menu is not treated as a security boundary.

The endpoint checks that the resolved target is a regular file before launching the file manager:

- macOS: run `open -R <absolute-file-path>`.
- Windows: run `explorer.exe /select, <absolute-file-path>` using an argument array so spaces in paths are preserved.

No shell command string is constructed from user input.

## Path Safety

Reveal is limited to the selected asset's primary `fileUrl`. Accepted files must resolve beneath a project-managed root, including the public asset storage and ephemeral workspace storage. URL parsing and normalization must reject traversal, malformed URLs, missing assets, directories, and paths outside these roots.

Remote HTTP URLs are not revealable. Published assets stored under `public/asset-published` remain revealable because their asset-library URLs resolve to local files.

## Error Handling

The API returns stable status codes for unavailable capability, missing asset, invalid path, missing file, and process launch failure. The sidebar displays a concise message such as `File no longer exists` or `Could not open Finder` without removing or modifying the asset entry.

## Testing

- Unit-test loopback hostname detection, including IPv4 and IPv6 forms.
- Unit-test platform capability labels for macOS, Windows, and unsupported platforms.
- Unit-test asset path validation against traversal and outside-root paths.
- Test that the reveal endpoint resolves assets by ID and never accepts a client-provided filesystem path.
- Run TypeScript checking and ESLint.
- Verify in the browser that right-click and trackpad secondary click open the menu, the reveal label is correct on macOS, and the action is absent when capability is unavailable.

## Non-Goals

- Revealing files stored on a remote deployment server from a visitor's computer.
- Adding Linux file-manager integration.
- Replacing the current Assets hover actions.
- Introducing Electron, Tauri, or a browser filesystem permission flow.
