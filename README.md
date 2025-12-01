# ReplySense - Gmail Extension

ReplySense is a Gmail enhancement extension that intelligently reads incoming emails and generates concise, tone-matched replies using AI — all with a single click.

## Features

- 🤖 **AI-Powered Replies**: Uses Google's Gemini API to generate intelligent email replies
- 🎯 **Context-Aware**: Analyzes the original email content to create relevant responses
- 🎨 **Tone Customization**: Choose from different reply tones (match original, friendly, concise, professional)
- 🔄 **Per-Thread Control**: Enable or disable the extension for individual email threads
- 📊 **Activity Logs**: Track your reply generation activity
- 🔒 **Privacy-First**: API keys are stored locally in your browser extension only
- ⚙️ **Flexible Configuration**: Support for multiple Gemini models (Flash, Pro, 2.0, 2.5)

## Installation

### From Source

1. Clone this repository:
   ```bash
   git clone https://github.com/PrerakPithadiya/replysense-gmail-extension.git
   cd replysense-gmail-extension
   ```

2. Open Chrome and navigate to `chrome://extensions/`

3. Enable "Developer mode" (toggle in the top right)

4. Click "Load unpacked" and select the project directory

5. The extension should now be installed and ready to use!

## Setup

1. **Get a Gemini API Key**:
   - Visit [Google AI Studio](https://makersuite.google.com/app/apikey)
   - Create a new API key for Gemini

2. **Configure the Extension**:
   - Click the extension icon in your Chrome toolbar
   - Enter your API Base URL (default: `https://generativelanguage.googleapis.com/v1beta`)
   - Paste your API key
   - Select your preferred Gemini model
   - Adjust max tokens and reply tone as needed
   - Click "Save"

## Usage

1. **Open an email** in Gmail (either in a new tab or in the Gmail interface)

2. **Enable the extension** for that thread by clicking the toggle button in the email toolbar

3. **Click "Generate Reply"** to create an AI-generated reply based on the email content

4. **Review and edit** the generated reply before sending

5. **View activity logs** in the extension popup to track your usage

## Configuration Options

- **API Base URL**: The base URL for the Gemini API (default: `https://generativelanguage.googleapis.com/v1beta`)
- **API Key**: Your personal Gemini API key (stored locally only)
- **Model**: Choose from available Gemini models:
  - `gemini-1.5-flash` - Fast and efficient
  - `gemini-1.5-pro` - Balanced performance
  - `gemini-2.5-pro` - Latest and most capable (recommended)
  - `gemini-2.0-pro` - Previous generation Pro model
  - `gemini-pro` - Legacy model
- **Max Tokens**: Maximum length of generated replies (512-8192, default: 4096)
- **Reply Tone**: 
  - Match tone (default) - Matches the original email's tone
  - More friendly - Adds warmth and friendliness
  - More concise - Keeps replies brief
  - More professional - Formal and business-like

## Requirements

- Google Chrome browser (or Chromium-based browsers)
- Active internet connection
- Valid Gemini API key from Google AI Studio

## Permissions

This extension requires the following permissions:
- `activeTab` - To interact with Gmail tabs
- `scripting` - To inject content scripts into Gmail
- `storage` - To save your API key and settings locally
- `https://mail.google.com/*` - To access Gmail pages

## Privacy & Security

- Your API key is stored **locally** in your browser's extension storage
- No data is sent to any third-party servers except Google's Gemini API
- All communication happens directly between your browser and Google's API
- The extension only accesses Gmail pages when you're actively using it

## Troubleshooting

- **Extension not working?** Make sure you've enabled it for the specific email thread using the toggle button
- **API errors?** Verify your API key is correct and has sufficient quota
- **No buttons appearing?** Refresh the Gmail page and ensure you're on `mail.google.com`
- **Context invalidated errors?** This usually happens after updating the extension - reload the Gmail page

## Development

This extension uses:
- Manifest V3
- Chrome Extension APIs (storage, scripting, activeTab)
- Google Gemini API

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues, questions, or feature requests, please open an issue on the GitHub repository.

