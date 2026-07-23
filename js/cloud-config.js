/*
 * Public cloud configuration.
 *
 * This public browser configuration enables optional account cloud sync.
 * Only the project URL and publishable/anon key may be placed here. Never put
 * a service-role key or any other administrator credential in this file.
 */
(function (root) {
    if (root.CPLAYER_CLOUD_CONFIG) return;
    root.CPLAYER_CLOUD_CONFIG = Object.freeze({
        url: 'https://fgebuqieitvmxjiwjnbh.supabase.co',
        publishableKey: 'sb_publishable_EOWT-Jd5HJhxZEZal_KjMg_Ipen9mNL'
    });
}(window));
