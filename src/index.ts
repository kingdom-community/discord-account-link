export {
    DEFAULT_CALLBACK_PATH,
    ENV_BASE_URL,
    ENV_CALLBACK_PATH,
    ENV_CLIENT_ID,
    ENV_CLIENT_SECRET,
    ENV_STATE_SECRET,
    discordLinkConfigFromEnv,
    discordLinkingConfigured,
    stateSecretFromEnv,
    type DiscordLinkConfig,
    type EnvSource
} from './config.js';

export {
    DISCORD_AUTHORIZE_URL,
    DISCORD_IDENTITY_URL,
    DISCORD_SCOPE,
    DISCORD_TIMEOUT_MS,
    DISCORD_TOKEN_URL,
    DISCORD_USERNAME_MAX_LENGTH,
    authorizeUrl,
    exchangeCodeForIdentity,
    type DiscordExchange,
    type DiscordIdentity,
    type ExchangeOptions,
    type FetchLike
} from './discordOAuth.js';

export {
    createHmacStateSigner,
    type StateSignatureCheck,
    type StateSigner
} from './stateSigner.js';

export {
    STATE_TTL_MS,
    issueState,
    verifyState,
    type StateVerdict
} from './oauthState.js';

export {
    linkOutcomeFrom,
    refusalFrom,
    type AccountLinkStore,
    type LinkHttpResponse,
    type LinkOutcome,
    type LinkResponseMapping
} from './linkStore.js';

export {
    createDiscordLinkFlow,
    type BeginOutcome,
    type CallbackParameters,
    type CompleteOutcome,
    type DiscordLinkFlow,
    type DiscordLinkFlowOptions,
    type LinkFlowOutcome
} from './flow.js';

export {
    activeSessionFrom,
    type ActiveSession,
    type ResolvedSessionLike
} from './session.js';

export {
    callbackResponse,
    unlinkResponse,
    type RouteResponse
} from './http.js';

export {discordLinkFlowFromEnv} from './fromEnv.js';
