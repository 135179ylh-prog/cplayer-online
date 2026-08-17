/** @type {import('tailwindcss').Config} */
module.exports = {
  // Every file that carries class-name strings must be scanned, or those classes
  // get purged from css/tailwind.css and the UI silently loses styling.
  content: [
    './index.html',
    './playlist-downloader.html',
    './js/app.js',
    './js/mobile-ui.js',
    './js/search-view.js',
    './js/playlist-view.js',
    './js/cloud-ui.js',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
