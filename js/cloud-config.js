/*
 * Public cloud configuration.
 *
 * These values are intentionally empty until a real Supabase project is
 * created. Only the project URL and publishable/anon key may be placed here.
 * Never put a service-role key or any other administrator credential in this
 * file.
 */
(function (root) {
    if (root.CPLAYER_CLOUD_CONFIG) return;
    root.CPLAYER_CLOUD_CONFIG = Object.freeze({
        url: '',
        publishableKey: ''
    });
}(window));
