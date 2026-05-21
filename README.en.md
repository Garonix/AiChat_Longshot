# Chat Longshot

Chat Longshot is an Edge / Chrome extension for capturing long screenshots from AI chat web pages. It lets you select a conversation range on pages such as ChatGPT, Gemini, DeepSeek, Grok, and Doubao, then automatically scrolls, captures, stitches, and exports the result as JPG images. When a capture is split into multiple JPG files, it can also merge them into a PDF.

## Features

- Manifest V3 extension for Microsoft Edge and Google Chrome.
- Supports popular AI chat pages including ChatGPT, Gemini, DeepSeek, Grok, and Doubao.
- Enters range selection mode directly when the extension icon is clicked.
- Adds candidate points beside chat messages.
- Supports selecting one or two candidate points.
- When two points are selected, the range is determined by page position rather than click order.
- When a third point is selected, the start point is kept fixed unless the new point is above it.
- Automatically jumps to the capture start before taking screenshots.
- Automatically scrolls, captures, and stitches frames with Canvas.
- Exports JPG by default.
- Splits very long captures into multiple JPG files.
- Optionally merges multiple JPG files into a PDF and silently tries to remove temporary JPG files.
- Tries to hide sidebars, input boxes, navigation bars, and other unrelated page elements during capture.

## Local Installation

### Edge

1. Open `edge://extensions/`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select this project directory.
5. Open a supported AI chat page and click the Chat Longshot icon in the browser toolbar.

### Chrome

1. Open `chrome://extensions/`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select this project directory.
5. Open a supported AI chat page and click the Chat Longshot icon in the browser toolbar.

## Usage

1. Open an AI chat page.
2. Click Chat Longshot in the browser toolbar.
3. Select one or two candidate points beside the conversation.
4. Click "截图" in the bottom toolbar.
5. Do not scroll manually while capture is running.
6. If multiple JPG files are generated, choose whether to merge them into a PDF.

## Privacy

The extension only reads the visual rendering of the current tab locally to generate image files. It does not upload chat content, call any AI platform API, or store chat text.

## Version

Current version: `v0.2.34`
