/* Fill these in after the Google Cloud setup in README.md.
   The app works fully offline without them; Drive sync stays switched off until they are set. */
window.APP_CONFIG = {
  // OAuth 2.0 Client ID (type: Web application), e.g. 1234567890-abc123.apps.googleusercontent.com
  GOOGLE_CLIENT_ID: 'YOUR_CLIENT_ID.apps.googleusercontent.com',
  // API key restricted to the Google Picker API (used for the folder picker). Leave empty to use paste-a-link only.
  GOOGLE_API_KEY: '',
  // Google Cloud project NUMBER (not the project ID). Needed by the folder picker.
  GOOGLE_APP_ID: '',
  // Full Drive scope lets everyone save into a shared folder and its existing site folders.
  // 'https://www.googleapis.com/auth/drive.file' is narrower but limits shared-folder use (see README).
  DRIVE_SCOPE: 'https://www.googleapis.com/auth/drive'
};
