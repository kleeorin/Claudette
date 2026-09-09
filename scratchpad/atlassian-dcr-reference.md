# Atlassian Dynamic Client Registration — measured reference

**Purpose.** Everything needed to build DCR for the `confluence` / `atlassian` built-ins, measured
from the live metadata on 2026-09-08 rather than remembered. Written because the research outlived
the context that produced it: Landing cleared before building this, and three queued messages are a
worse handoff than one file.

**Method.** Public `GET`s only. No credentials sent. **No registration POST was attempted** — that
creates a real client on Atlassian's side and is the operator's call, so every value below is read
from metadata, not from a registration response.

---

## Why this exists at all

`confluence` is the one connector family the OAuth flow does not serve. It carries no
`requiresOAuthClient` (so the manual client route is not wired for it) and DCR — the mechanism it
was designed around — is not built. It therefore has **no path to a token by any route** until this
lands. Google, by contrast, works once the operator creates a client.

## ★ The registration endpoint in our own source is WRONG

`builtins.ts` says Atlassian supports DCR, and an earlier review reported the endpoint as
`https://mcp.atlassian.com/v1/register`. The authorization server's own metadata disagrees:

    registration_endpoint: https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3/dcr/register

Different host, different path. **Discover it; do not hardcode either string** — that opaque path
segment is exactly the kind of value a vendor rotates. The two-hop chain a spec-following client
walks, and the one that produced this file:

1. `GET https://mcp.atlassian.com/.well-known/oauth-protected-resource/v1/mcp/authv2`
   → `authorization_servers: ["https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3"]`
2. `GET <that>/.well-known/oauth-authorization-server` → the endpoints below.

## Authorization server metadata, as measured

| field | value |
|---|---|
| `issuer` | `https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3` |
| `authorization_endpoint` | `https://auth.atlassian.com/authorize` |
| `token_endpoint` | `https://auth.atlassian.com/oauth/token` |
| `registration_endpoint` | `https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3/dcr/register` |
| `revocation_endpoint` | `https://auth.atlassian.com/oauth/revoke` |
| `code_challenge_methods_supported` | `["S256"]` — **S256 only, no `plain`** |
| `token_endpoint_auth_methods_supported` | `["none", "client_secret_post", "client_secret_basic", "private_key_jwt"]` |
| `grant_types_supported` | `authorization_code`, `client_credentials`, `refresh_token`, token-revoke, jwt-bearer, token-exchange |

**`"none"` is supported → register as a PUBLIC client.** No client secret at rest for Atlassian at
all, which is strictly better than storing one and is the same property that makes a Google
*Desktop app* client attractive.

## Scopes — advertised by the resource, so no guessing

Confluence set: `search:confluence`, `read:confluence-user`, `read:page:confluence`,
`write:page:confluence`, `read:comment:confluence`, `write:comment:confluence`,
`read:space:confluence`, `read:hierarchical-content:confluence`. Plus `read:me`, `read:account`.

**`offline_access` is REQUIRED for a refresh token** — Atlassian's equivalent of Google's
`access_type=offline`. Without it the connector works for about an hour and then dies silently.
Put it in the preset where it cannot be forgotten, exactly as the Google wart was handled.

**Request ONLY the Confluence set.** The same endpoint advertises Jira, Compass and TWG scopes;
the union would put Jira write access on a consent screen for someone who asked for Confluence.
See the menu-not-an-order note below — this is the same argument.

## `scopes_supported` is a MENU, not an ORDER

Discovery must **validate what we ask for and never choose it**. Requesting a provider's advertised
set reintroduces over-granting through the discovery door: Gmail advertises
`https://mail.google.com/` (unrestricted mailbox access including permanent deletion), so a
connector requesting its advertised set would show the most alarming consent screen in the catalog
to someone connecting calendar tooling.

A frozen list of what we ASK FOR is a different object from a live list of what a provider WILL
GRANT, and only the first is ours to choose. The usual "don't freeze anything" argument does not
transfer here. Discovery is wired as an advisory validator: it warns by name when a requested scope
is not advertised, is time-limited, and is never fatal — a slow provider must not block an operator
from authorizing.

## A documented limitation that may not be one

The revocation asymmetry currently in `CONNECTORS.md` says disconnecting removes only our copy and
the token stays valid at the provider. **Atlassian publishes `revocation_endpoint`**, so for
Atlassian a disconnect could genuinely revoke rather than merely forget — which is what operators
assume they are getting. Check whether Google publishes one too (`https://oauth2.googleapis.com/revoke`
is the usual value) and let the preset carry it, so the wording can become "revoked where the
provider supports it" instead of a blanket caveat.

## Build notes

- Its own path with its own harness. It is a **second credential-acquisition path**, not a branch of
  the existing exchange.
- Treat the registration response as **untrusted input** — validate before storing.
- **Persist the registered client** so a restart does not re-register and orphan the old one.
- Registration needs no operator console step, no client secret to paste, and no redirect-URI
  pre-registration to go stale. That is most of what makes the Google path awkward, absent here.
