# @kingdom-community/discord-account-link

Link a Discord identity to an account on your own community site. A small,
server-side TypeScript implementation of the Discord OAuth2 authorization-code
flow that asks for the `identify` scope and nothing else, uses the resulting
access token for exactly one `/users/@me` call, and then discards it — so there
is never a Discord token in your database to leak. The flow refuses to start or
to render an affordance unless it is fully configured, because a button that
dies at the redirect is worse than no button.

The library is coming; this is a stub.
