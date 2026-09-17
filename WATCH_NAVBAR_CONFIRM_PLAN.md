# Plano — Navbar global + confirmação via link do bot

## 0. Decisões trancadas

- **OpenID mantido** (prova identidade) + **clique no link** (prova canal/ativação, com login imediato).
- **`/watch` vira redirect para `/`**; fluxos vivem na navbar + painel compacto.
- **Avatar via Steam API** a cada load, com fallback, só para logados.
- **Nova tabela `accounts`** (sem tabela de token separada: colunas `confirm_token_hash`/`confirm_expires_at` nullable).
- Sequência do link: **site mostra o passo** (aceite o convite → bot manda o link no chat → clique confirma).

## 1. Estado atual (ponto de partida)

- Auth OpenID + `iron-session` implementados; rotas watch self-scoped; `/watch` é página com `WatchManager` + `WatchInbox`; identidade via sessão (localStorage removido).
- Amizade continua pré-requisito do chat (limitação da Steam, sem deadlock novo: o convite sai no signup, antes do link).
- Sem navbar: `LanguageSwitcher` flutua em `fixed top-4 right-4` dentro do `Home.tsx` (cobre `/` e `/player`).

## 2. Persistência — migration `005_accounts.sql`

```sql
CREATE TABLE IF NOT EXISTS accounts (
  steam_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,              -- NULL = registrado, link ainda não clicado
  confirm_token_hash TEXT,        -- SHA-256 hex do token, nunca plaintext
  confirm_expires_at TEXT,        -- ~24h; NULL fora de vigência
  locale TEXT
);
```

- Token: `crypto.randomBytes(32).hex()`; guarda-se `sha256(token)`; expiração ~24h; re-emissível.
- DAL (`src/lib/analytics/db.ts`, padrão existente): `createAccount` (INSERT OR IGNORE — idempotente), `getAccount`, `issueConfirmToken`, `consumeConfirmToken` (1 UPDATE atômico com predicado + checagem de `rowsAffected`; comparação em hash).
- Testes: mock (DAL) + integração real (consumo duplo concorrente → só 1 vence; expirado rejeita; reuso pós-consumo rejeita).

## 3. Signup — `POST /api/auth/signup` (exige sessão OpenID)

- Lê `steamId` da sessão (401 sem); `locale` do body.
- Cria `accounts` (não confirmado) + `watched_profiles` pending + invite (reusa DAL existente); emite o token.
- Rate limit + CSRF Origin + 400/401/500 no padrão das rotas watch. Testes unitários espelhando `watch/request`.

## 4. Bot entrega o link (1 ponto de toque)

- Novo env `WATCH_SITE_URL` (base absoluta; dev e prod distintos).
- Em `index.ts`, no `onActivated`: `getAccount` → se `confirmed_at` nulo, envia mensagem de confirmação (`SITE_URL/api/watch/confirm?token=<hex>`) em vez do welcome; se confirmada, welcome atual.
- Template novo em `notificationText.ts` (`confirmText(locale, url)`) nas 5 línguas + testes.
- Sem fila nova, sem lane nova, sem mudar cooldown/cap/TTL/opt-out.

## 5. Confirmação — `GET /api/watch/confirm?token=`

- Funciona **deslogado**: valida hash + expiração + consome em 1 UPDATE atômico → seta `confirmed_at` → **sela a sessão** (login imediato) → redirect `/` com toast de sucesso.
- Token inválido/expirado/já-usado → redirect `/` com erro amigável.
- Rate limit. Testes: sucesso, reuso, expirado, inválido, sem sessão prévia com sessão criada.

## 6. Navbar global — `SiteNav`

- Novo Server Component async em `[locale]/layout.tsx`: cluster fixo top-right com `LanguageSwitcher` (movido do `Home.tsx`), sino (`WatchInbox` com steamId da sessão) e avatar/sign-in.
- Logado: avatar 40px redondo (`getSteamAvatarUrl(steamId)` server-side via `steamapi`; fallback letra/SVG; falha da API nunca quebra a página) + dropdown (status do watch, link do painel, sign out).
- Deslogado: botão Steam (link para login com `next` = página atual).
- Sem polling novo, sem estado global novo; SSR lê a sessão direto (sem flash).

## 7. Dissolução do `/watch`

- Rota vira `redirect('/')` permanente (preserva bookmarks).
- `WatchManager` vira conteúdo do painel compacto (mesmos estados pending/active/none + Start explícito — sem auto-POST, sem re-inscrição pós-opt-out).
- Deletar o obsoleto da página; atualizar testes e2e que navegam para `/watch`.

## 8. i18n (5 locales, paridade testada)

- Novas: botão signup/login, passos ("aceite o convite", "clique no link do chat"), sucesso da confirmação, erro de link expirado, alt do avatar, status do dropdown.
- Textos do bot-link traduzidos; nada hardcoded.

## 9. Testes (DoD)

- Unit + integração (DAL, rotas, libs, componentes).
- E2E da jornada completa: signup → invite → amizade mockada → link entregue (seam de teste lê o token pendente em `DEV_TEST_MODE`, mesmo gate do `test-login`) → clique → conta confirmada + sessão ativa + sino.
- Gates: lint, `tsc --noEmit`, Jest total, Playwright total.

## 10. Docs e validação final

- `WATCH_BOT_RUNBOOK.md` (bot envia link, `WATCH_SITE_URL`, warm-up), `AGENTS.md` (rotas/tabelas novas), `WATCH_PROD_READINESS.md` (atualizar sign-offs).
- Checklist pré-merge: sem segredo/token plaintext em log ou resposta; token single-use real; expiração aplicada; `/watch` antigo redirecionando; suite verde ponta a ponta.

## 11. Ordem de execução

1. Migration + DAL + testes → 2. signup + confirm + testes → 3. bot (template + branch + env) → 4. `SiteNav` + avatar + mover switcher → 5. dissolver `/watch` + limpar obsoleto → 6. i18n ×5 + paridade → 7. e2e + validação total + docs.

## 12. Emenda — click-to-activate (pós-bug reportado)

 Correção de comportamento: amizade com o bot NÃO ativa mais o watch.
 Antes, `activateWatch` disparava no aceite (reconcile) e o link servia só
 de login-bônus — o watch notificava e o site tostava sem clique. Agora a
 ativação exige o clique, e o plano acima lê-se com estes ajustes:

- **Gate no DAL**: `activateWatch` exige `confirmed_at` (carve-out: linhas
  legado sem `accounts` ativam como antes — consentiram no contrato antigo).
- **Aceite da amizade**: reconcile manda SÓ o link (hook novo,
  sem ativar); confirmadas ativam + welcome como antes. O hook emite
  SOMENTE na primeira vez (sem hash armazenado): nunca reemite sobre
  token expirado — expirados pertencem ao fluxo aviso+resend, nunca ao
  reconcile (senão o aviso único morreria de inanição e o throttle de 1h
  seria contornado).
- **Clique**: `GET /api/watch/confirm` virou página intermediária (imune a
  prefetch/linkifier/antivírus); `POST` consome + ativa + enfileira
  `welcome` + sela sessão. CSRF de Origin como signup/logout. Decisão
  pós-review (auto-submit removido): a página NÃO carrega elemento <script> —
  só o clique explícito no botão confirma, então abrir/previewar a URL
  nunca gasta o token em nenhum contexto (nem headless visível+focado).
- **Welcome**: evento `welcome` entregue pelo bot (o site não alcança o
  chat). POST só enfileira quando ele mesmo ativou (backstop ativa via
  `onActivated` e dá seu próprio welcome — sem duplo).
- **Expiração (24h mantido)**: sem resend automático. Poller do bot manda
  UMA mensagem ("link expirou, gere outro no site") por geração de token,
  com recheck pré-envio + write condicional (clique concorrente sempre
  vence). Marker `confirm_expire_noticed_for` (migration 008).
- **Gerar novo**: `POST /api/auth/confirm-resend` (sessão + CSRF +
  rate-limit) enfileira `confirm_resend`; o bot emite (sole issuer) com
  throttle de 1h por perfil; UI no pending expirado (`confirmExpired` no
  status + 3 chaves i18n ×5 locales).
- **Backstop**: reconcile periódica (10min) converge ativações cujo clique
  caiu com o DB fora do ar; `GET /api/watch/status` carrega
  `confirmExpired` (degrada para false com log, nunca 500a o poll).
- **Sem migration destrutiva**: só 008 (coluna nullable). **Nunca renomear**
  migration aplicada (incidente 007: aplicada como 006, renomeada, replay
  quebrou o migrate — ver contrato em `scripts/migrate-db.ts`).
- Cobertura: gate + scan + marker no DAL (mock + real libSQL), ramos do
  reconcile, split do activation, GET/POST da rota, 3 pollers, resend
  route/UI, journey e2e reescrita (aceite→pending sem toast; POST→active;
  expirado→resend). `useWatchStatus` inalterado (o toast passa a significar
  "confirmado" de verdade).

## 13. Emenda — modelo single-state (login gated por amizade)

 Troca o funil para usuários novos deslogados: **adicionar o bot → Sign in
 with Steam → watch `active` direto** (sem Start, sem pending, sem link).
 O que muda e o que NÃO muda:

- **Callback OpenID** (`callback/route.ts`): 3º gate — `isBotFriend` via
  `GetFriendList` da conta `STEAM_BOT_STEAMID` (lista do bot tem que ficar
  PÚBLICA), 8s timeout, fail-closed (`false` → `?auth=nofriend` com toast
  que ensina o fluxo; `null`/env ruim → `?auth=error`, sem sessão).
  Ordem load-bearing: `ensureActiveWatch` (fatal) → `recordLogin` (audit,
  non-fatal, migration 010) → welcome UMA vez se ativou (3 tentativas,
  non-fatal) → `saveWatchSession`. `?watch=new` é o único sinal de
  "watch live" (não existe mais pending para estrear).
- **Bot aceita inbound** (`bot.ts`): `RequestRecipient` → `addFriend`
  (live + sweep de chegadas offline, sequencial). LIMITADO no sink:
  `BOT_AUTO_ACCEPT_DAILY_LIMIT` (50/dia UTC, só sucesso consome) +
  `BOT_AUTO_ACCEPT_FRIEND_CAP` (240 amigos, headroom sob o teto Steam de
  250) — recusa loga `REFUSED`/`sweep paused` (alerta de disponibilidade,
  runbook §5); exaustão (ataque ou crescimento) adia onboarding novo até
  intervenção — shard `ACQ_BOT_*` é a resposta de escala (backlog).
- **NÃO morreu**: `POST /api/auth/signup` + botão Start + `invitePoller` +
  `GET/POST /api/watch/confirm` seguem vivos para o **re-watch pós-opt-out**
  (o cookie sobrevive ao unfriend: stale `none` → Start → pending →
  convite do bot → link → clique) e para tokens legados. Usuário novo
  deslogado nunca encosta nisso. `activateWatch` mantém o gate
  `confirmed_at` para a lane do link, e `ensureActiveWatch` espelha o
  MESMO predicado no login (vira `active` só sem linha em `accounts`
  — carve-out legado — ou com conta já confirmada; pending + conta
  não-confirmada continua pending até o clique). Re-login nunca pula o
  clique: §12 segue valendo em todas as lanes (sign-off 8b).
- **Retry de accepts diferidos**: o sweep de inbound (`acceptPendingRequests`)
  roda no `friendsList` E no timer de reconcile (10min) — teto/diário
  adiados convergem sem reconnect (virada do dia UTC, slots liberados).
- **Latência/quota do login** (aceito, monitorar): +1 `GetFriendList` (8s
  cap) + 1-3 queries + audit por login; quota `STEAM_API_KEY`/`_2`
  compartilhada com busca (mitigação atual: sorteio entre as duas chaves).
  Medir p95/p99 pós-deploy; sem chave dedicada por ora.
