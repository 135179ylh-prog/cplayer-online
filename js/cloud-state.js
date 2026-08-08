// Mutable cloud-sync state, extracted from js/app.js.
//
// One shared object rather than accessor pairs: property assignment keeps the
// write ordering identical to the original code, and every reader sees the same
// object identity, so there is no way to end up with two copies of a value.
//
// The cloud functions still live in js/app.js and move in later steps. Holding
// the state here first means those steps need no injected setters.
export const cloudState = {
    cloudService: null,
    cloudSession: null,
    cloudUserId: '',
    cloudAuthSubscription: null,
    cloudAccountBusy: false,
    cloudRecoveryMode: false,
    cloudState: 'disabled',
    cloudStateMessage: '云同步尚未配置，播放器仍可本地使用',
    cloudSyncTimer: null,
    cloudSyncInFlight: null,
    cloudSyncPendingReason: '',
    cloudPendingCount: 0,
    cloudPendingItems: [],
    cloudPendingReadToken: 0,
    cloudLastSuccessfulAt: 0,
    cloudLastErrorMessage: '',
    cloudHealthCheckBusy: false,
    cloudHealthSnapshot: null,
    cloudHealthRevision: 0,

    // Storage keys, grouped with the state they describe.
    CLOUD_DETACH_PENDING_KEY: 'cp_cloud_detach_pending',
    CLOUD_LAST_SUCCESS_KEY: 'cp_cloud_last_success',
    CLOUD_LAST_ERROR_KEY: 'cp_cloud_last_error',
};
