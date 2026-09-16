# Manual de Teste Ponta a Ponta — feat/steam-profile-watch

Roteiro de QA manual do Watch com confirmação via bot, cobrindo a jornada feliz,
o click-to-activate, link expirado, gerar-novo-link, throttle, logout, opt-out,
bot desligado, matriz de idiomas e aceite de segurança.

> Escopo: comportamento observável com contas Steam reais + banco Turso de DEV.
> Rate-limit 405/403/429, condições de corrida, retries de DB e janelas de
> cooldown longas são cobertos por automatizados — ver §14 e não retestar na mão
> (lento e inconclusivo).

---

## 0. Pré-requisitos

| #   | Item               | Detalhe                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 2 contas Steam     | Uma para o **bot**, outra de **testador** (recebe convite, lê chat). **Use só contas próprias de teste** — alguns casos validam tradeoffs aceitos de propósito.                                                                                                                                                                                           |
| 2   | Banco Turso de DEV | Crie um só para isso. **Nunca rode estes testes contra produção.**                                                                                                                                                                                                                                                                                        |
| 3   | `.env` local       | `DATABASE_URL` + `DATABASE_TOKEN` (DEV); `SESSION_SECRET` com 32+ chars; `STEAM_BOT_USERNAME`, `STEAM_BOT_PASSWORD`, `STEAM_BOT_SHARED_SECRET`; `WATCH_SITE_URL=http://localhost:3000`; `STEAM_API_KEY` (opcional — sem ela o avatar cai em fallback de letra, o fluxo funciona). `DEV_TEST_MODE` **desligado/ausente** (ligado ativa fixtures mockadas). |
| 4   | Primeira vez       | `pnpm run start:bot` interativo e aprove o Steam Guard no celular (ver `WATCH_BOT_RUNBOOK.md` §3).                                                                                                                                                                                                                                                        |
| 5   | Migração           | `pnpm run db:migrate` → `✔ All migrations applied.` e `_migrations` contém `008_accounts_expire_notice.sql`.                                                                                                                                                                                                                                              |
| 6   | Subir tudo         | Terminal 1: `pnpm run dev` (`:3000`). Terminal 2: `pnpm run start:bot`.                                                                                                                                                                                                                                                                                   |

### 0.1. Acelerando o tempo (obrigatório p/ testar expiração sem esperar 24h)

No `.env`, **antes** de ligar o bot (TTL e scan são lidos só pelo bot; o site lê
o banco ao vivo e não precisa reiniciar):

```sh
BOT_CONFIRM_TOKEN_TTL_MS="120000"   # link expira em 2 min (default 24h)
BOT_EXPIRY_SCAN_INTERVAL_MS="60000" # varredura de expirados a cada 1 min (default 1h)
```

Para voltar ao normal, apague as linhas e reinicie o bot.

### 0.2. As 4 superfícies de observação (use as 4 em todo caso)

1. **Chat Steam do testador** — o que o bot realmente mandou (texto exato
   importa).
2. **Browser** — dropdown do avatar (`none`/`pending`/`active`), toasts,
   sino/badge, inbox. DevTools → Application → Cookies →
   `steamreveal_watch_session` (presente = logado; ausente = deslogado).
3. **Banco** (dashboard Turso ou `turso db shell`):
   ```sql
   SELECT steam_id, confirmed_at, confirm_expires_at, locale FROM accounts WHERE steam_id='<ID64>';
   SELECT steam_id, status, locale FROM watched_profiles WHERE steam_id='<ID64>';
   SELECT id, kind, status, created_at, sent_at FROM watch_events WHERE steam_id='<ID64>' ORDER BY id DESC LIMIT 20;
   ```
4. **Logs do bot** — `reconcile done (... linksSent=)`, `welcome poll done`,
   `resend poll done`, `expiry scan done`, `raced by a click`, `friend-remove`.
   Liveness: `pnpm run healthcheck:bot`.

### 0.3. Reset entre ciclos (faça sempre, salvo "sem reset" explícito)

1. Na Steam do testador: **desfazer amizade com o bot** (remove
   `watched_profiles` + `accounts` atomicamente).
2. No site: avatar → **Sign out** (mata o cookie).
3. Confira no banco: os dois `SELECT`s acima voltam vazios.

---

## 1. Jornada feliz (base de tudo)

### QA-01 — Signup → convite → amizade → link (sem ativar!)

1. Navegador limpo: `http://localhost:3000/en` → mostra **Sign in**, sem
   sino/avatar.
2. **Sign in with Steam** → login real → volta logado (avatar aparece).
3. Abra o avatar → `Watch a Steam profile` + `Watch your profile`. Logout (Sign
   out) visível ao lado.
4. Clique `Watch your profile` → heading `Invite sent`.
5. Banco: `watched_profiles.status='pending'`; `accounts.confirmed_at=NULL`.
6. Na Steam: aceite o pedido de amizade.
7. **Esperado (o bug corrigido): NADA ativa.** Sem toast `Watch active!`,
   dropdown segue `Invite sent`, banco segue `pending` + `confirmed_at=NULL`.
   Aguarde ~10s (2 polls de 5s) e reconfirme.
8. No chat: chega a mensagem com o link (template de confirmação no seu idioma).
9. Banco: `confirm_token_hash` com 64 hex (**nunca o token plano**),
   `confirm_expires_at` ≈ agora+TTL.

### QA-02 — Página intermediária (GET não gasta nada, POST automático com JS)

1. Abra o link do chat → a página `Confirm your Watch request` dá POST
   sozinha (auto-submit inline) e cai em `/en/?confirmed=ok`. Não há mais
   botão visível para quem tem JS — clicar virou abrir.
2. Desligue o JS do navegador e repita: o form + botão `Confirm and
   activate` aparecem (fallback noscript) e recarregar (F5) 2x mantém o
   form — simula preview/antivírus, que nunca executam o script.
   **Esperado sem JS: o form continua lá, nada é gasto.**
3. Banco (antes de qualquer POST): `confirmed_at` NULL, `status` pending,
   hash inalterado.
4. Extra: `curl.exe -s "LINK" | Select-String "<form"` → o form existe (o
   `<script>` vem junto no HTML mas curl não o executa — prova de que
   preview não gasta).

### QA-03 — A abertura ativa tudo

1. Na página do QA-02 (com JS), aguarde o auto-submit.
2. **Esperado:** redirect `/en/?confirmed=ok` + toast
   `Watch confirmed! You will be notified here whenever your profile is searched.`
   (some sozinho; reload não repete).
3. Banco: `confirmed_at` preenchido + token zerado; `status='active'` +
   `activated_at`; evento `kind='welcome'` → `sent`.
4. Em ~5s: toast
   `Watch active! The bot will message you on Steam when this profile is searched.` +
   dropdown vira `Watching`.
5. No chat: `SteamReveal Watch is now active for your profile...`.
6. Cookie `steamreveal_watch_session` presente. Repita o clique em aba anônima
   (sem sessão): funciona e loga **lá** (design logged-out de propósito).

### QA-04 — Busca gera notify → sino → inbox

1. Com watch `active`, busque o perfil **digitando a URL direto** (não pelo link
   do bot — pelo link a busca é suprimida, ver QA-12).
2. Em ~1 min (poll de 60s): mensagem no chat + sino com badge `1 unread`.
3. Abra o sino: item listado, badge zera, reload mantém zerado.
4. Banco: `kind='notify'` → `sent`; `last_notified_at` preenchido.
5. **Cooldown:** busque de novo → **nada por 24h** (teto de 1 aviso/dia). Para
   retestar sem esperar:
   `UPDATE watched_profiles SET last_notified_at='2000-01-01T00:00:00.000Z' WHERE steam_id='<ID64>'`
   e busque de novo.

### QA-05 — Logout nos 3 estados

Para `none` (reset sem signup), `pending` (signup sem clique) e `active`: avatar
→ **Sign out** existe → clica → volta `Sign in`, sino some, cookie some. (O
`none` não tinha logout antes deste fix.)

### QA-06 — Opt-out + re-signup fresco

1. Com tudo ativo: na Steam, **desfaça amizade** (repita outro ciclo bloqueando
   em vez de desfazer).
2. Banco: **as duas linhas sumiram**. Dropdown volta a `Watch a Steam profile`.
   Histórico antigo do sino **permanece** (event log sobrevive por design);
   novas buscas não notificam.
3. Clique `Watch your profile` → ciclo recomeça **não-confirmado** (novo
   convite, novo link — nunca reaproveita confirmação velha).

---

## 2. Click-gating (provas de que amizade sozinha não ativa)

- **QA-07 — Aceite sem clique.** Já coberto no passo 7 do QA-01; para pinar:
  após aceitar, busque o próprio perfil → **nenhuma mensagem** (watch ainda
  `pending` → hook retorna `not-active`).
- **QA-08 — Prefetch via curl.** Com link vivo:
  `curl.exe -s "LINK" | Select-String "<form"` → o form existe; repita 3x;
  depois complete o QA-03 normalmente (prova que GETs não gastaram o token).
- **QA-09 — POST sem Origin.** `curl.exe -X POST "LINK"` (sem header Origin) →
  `403`. Com `Origin: http://localhost:3000` mas sem sessão e token válido →
  consome e ativa (302 para `?confirmed=ok`), provando o design logged-out.

## 3. Link expirado + gerar novo (TTL acelerado do §0.1)

Faça QA-01 até o link e **não clique**.

### QA-10 — Expiração: um aviso, uma vez só, só se não clicou

1. Aguarde ~3 min (expirar + 1 varredura).
2. **Esperado no chat, exatamente 1x**, no idioma do signup:
   - en:
     `Your confirm link expired. Open SteamReveal, sign in, and generate a new one from the Watch panel.`
   - pt:
     `Seu link de confirmação expirou. Abra o SteamReveal, entre com a Steam e gere um novo no painel do Watch.`
   - es/de/ru: textos em `getConfirmExpiredText`
     (`src/lib/watch/notificationText.ts`).
3. Aguarde +2 ciclos: **nenhuma segunda mensagem**. Banco:
   `confirm_expire_noticed_for` = expiração avisada; status segue `pending`; log
   `expiry scan done: ... notified=1`.
4. Clique no link **morto**: página variante expirada (`This link expired`, sem
   form). Forçando o POST: `?confirmed=error` +
   `This confirmation link is invalid or expired...`.

### QA-11 — Prova negativa (clicado-a-tempo nunca recebe aviso)

Novo ciclo, receba o link, **clique ~30s antes de expirar** (complete QA-03).
Passe da expiração original + 2 scans: **nenhuma mensagem de "expirou" chega
nunca** (recheck pré-envio + write condicional barram; logs não mostram
`notified` para esse perfil).

### QA-12 — Gerar novo link pelo site

1. Estado expirado (fim do QA-10). Avatar → `Invite sent` agora mostra bloco
   expirado + `Generate new link`.
2. Clique → `New link on its way — check your Steam chat.` (sem signup
   disparado).
3. Chat: link fresco. Banco: `confirm_expires_at` novo (o aviso rearma sozinho,
   sem escrita extra).
4. Link **antigo** → erro. Link **novo** → ativa (QA-03). Bloco expirado some do
   dropdown.

### QA-13 — Throttle (spam de botão ≠ spam de chat)

Com link expirado, clique `Generate new link` **5x rápido**. **Esperado:
exatamente 1 mensagem no chat** (as demais caem em `throttled`, piso de 1h; logs
`reason=throttled`). Banco: 1 evento `confirm_resend` → `sent`, demais →
`dropped`.

### QA-14 — Expiração sem ação posterior = silêncio intencional

Novo ciclo: aceite a amizade (link chega), ignore o LINK até expirar
(aviso chega, QA-10) e então **não faça mais nada** — nem clique em
gerar, nem desfaça amizade. Aguarde 2 ciclos de scan. **Esperado:**
nenhuma outra mensagem chega, nunca (sem resend automático por decisão
de produto; o bot só age de novo mediante pedido explícito). Status
segue `pending`, banco inalterado após o marker. As únicas saídas desse
estado são o botão "Generate new link" (QA-12) ou desfazer a amizade e
recomeçar (QA-06).

### QA-43 — Inbox rico: detalhe por sessão + contador mensal + split sem-cooldown

1. Com watch `active`, busque o próprio perfil (URL direta) e **abra o
   relatório de cheater** nessa busca; aguarde o notify (~1 min).
2. Abra o sino: o item mostra o texto completo + link, e abaixo a linha da
   sessão — data da busca + `Cheater report opened` (ou equivalente no
   idioma). O `datetime` do `<time>` é a própria busca.
3. No topo do painel, à direita: o badge `{N} searches this month`
   (N ≥ 1). Repita sem abrir o cheater: o item seguinte vem **sem** a
   linha do selo. O chat do bot, em contraste, traz só o teaser curto +
   link (ispa vs. detalhe de propósito).
4. **Split bot × inbox (sem cooldown no inbox).** Busque o perfil de novo
   em seguida (< 24h do notify): o chat **não** recebe segunda mensagem
   (cooldown 24h do bot), mas o sino **lista a nova busca** e o badge
   mensal incrementa. Essa é a decisão de produto: entrega com throttle,
   histórico sem throttle.

## 4. Erros e bordas

| ID    | Caso                               | Como fazer                                                                                                                                                        | Esperado                                                                                                                           |
| ----- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| QA-15 | Token malformado                   | `/api/watch/confirm?token=nope`                                                                                                                                   | Redirect `?confirmed=error`, zero leitura de token no banco                                                                        |
| QA-16 | Link com ponto grudado             | Cole o link + `.` no fim (linkifier da Steam faz isso)                                                                                                            | Página/form funcionam com o token limpo                                                                                            |
| QA-17 | Clique duplo                       | Mesmo link em 2 abas, abra as duas quase juntas (cada uma dá auto-submit)                                                                                         | Uma vira `ok`, a outra `error` (single-use: segundo `consume` acha zero linhas)                                                    |
| QA-18 | Re-clique dias depois              | Clique um link já consumido                                                                                                                                       | Página mostra o form (sem oráculo), POST cai em `error`                                                                            |
| QA-19 | Linha apagada na mão com link vivo | Delete a linha `accounts` com token pendente, clique o link                                                                                                       | Página de erro, **sem crash**; no próximo pass do bot a lane legado (sem linha em `accounts`) ativa direto + welcome — nunca trava |
| QA-20 | Signup deslogado                   | `POST /api/auth/signup` sem cookie (curl/DevTools)                                                                                                                | `401`                                                                                                                              |
| QA-21 | Watch de terceiros impossível      | Logado, DevTools: `fetch('/api/auth/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({steamId:'<OUTRO_ID>',locale:'en'})})` | `400` (identidade só da sessão)                                                                                                    |
| QA-22 | Status com `?steamId=`             | Navegue `/api/watch/status?steamId=<ID>` logado                                                                                                                   | `400` (self-scoped)                                                                                                                |
| QA-23 | Resend com link ainda válido       | Via DevTools, `POST /api/auth/confirm-resend` logo após receber o link                                                                                            | `200 {ok:true, queued:true}` mas **nenhuma** nova mensagem (bot descarta como throttled; confira `dropped`)                        |
| QA-24 | Resend já confirmado/sem linha     | Mesma chamada com watch `active` ou sem `accounts`                                                                                                                | `200 {ok:true, queued:false}`, zero eventos criados                                                                                |
| QA-25 | Resend deslogado                   | POST sem cookie                                                                                                                                                   | `401`, zero eventos                                                                                                                |

## 5. Sessões e logout

- **QA-26 — Dois browsers.** Logado em A e B: logout em A → B **continua
  logado** (sessões são por cookie, sem store no servidor para revogar em
  massa).
- **QA-27 — Kill-switch global.** Troque `SESSION_SECRET`, reinicie o dev server
  → avatar some em todo browser (selo não abre) → login de novo funciona. É o
  único "deslogar todo mundo".
- **QA-28 — Cookie.** Após QA-03 o cookie existe (`HttpOnly`, 30 dias); após
  logout, some. Sessão nunca contém nada além de `{steamId, expiresAt}`.

## 6. Opt-out, convite e bot desligado

- **QA-29 — Desfazer com pendente.** Signup → **antes** de aceitar,
  desfaça/cancele o convite → linhas removidas → dá para pedir de novo na hora
  (sem trava de 7 dias nesse caso).
- **QA-30 — Re-friending silencioso.** Após opt-out, re-adicione o bot na Steam
  **sem** clicar Start → silêncio total (sem linha, sem welcome, sem watch). Só
  o Start recria.
- **QA-31 — Ignorar o convite.** Signup → nunca aceite → silêncio para sempre
  (sem token emitido, sem canal de chat, varredura de expirados ignora —
  `confirm_expires_at` NULL).
- **QA-32 — Restart não duplica link.** Com link vivo pendente, reinicie o bot
  2x → **continua 1 mensagem** no chat (dedupe por token vivo no boot pass).
- **QA-33 — Clique com bot desligado.** Pare o bot, clique o link → ativa normal
  (site+DB bastam: toast, sessão, `active`). Suba o bot → welcome chega via
  outbox. Prova o desacoplamento.
- **QA-34 — Busca com bot desligado.** Pare o bot, busque o perfil ativo, suba o
  bot → notify entregue ao voltar (fila `queued` drena no boot).
- **QA-35 — Expirado com bot desligado.** Expiração ocorre com bot parado → ao
  subir, o aviso chega no primeiro pass (catch-up do scan).
- **QA-36 — Double-Start.** Duplo-clique rápido em `Watch your profile` → **1**
  convite (disciplina de invite; confira 1 evento `invite` aberto no banco).
- **QA-37 — Re-request após 7 dias.** Com `pending` + convite ignorado:
  `UPDATE watched_profiles SET requested_at='<7+ dias atrás>'` → Start → novo
  invite é enviado (refresh + re-enqueue). Sem o SQL, esse caso é só
  automatizado.

## 7. Matriz de idiomas

Repetir QA-01→QA-03 com reset entre linhas, trocando no `LanguageSwitcher`:
mensagem do link, página de confirmação, welcome, aviso de expirado e UI de
resend. Mínimo `en` + `pt`; ideal as 5 (`es`, `de`, `ru` — textos em
`CONFIRM_PAGE_TEXT` na rota, `notificationText.ts` e `messages/*.json`, paridade
fiscalizada por `watchLocales.test.ts`). **Armadilha de propósito:** signup em
pt + browser em en → a página de confirmação sai em **pt** (segue o idioma
armazenado, não o do browser).

## 8. Segurança aceita (validar que se entende, não que "falhou")

- **QA-38 — Link encaminhado (só entre contas próprias!).** Mande o link para
  sua 2ª conta e clique por ela: quem clicar **primeiro** confirma+loga como o
  dono e mata o link; o segundo vê erro. É o tradeoff login-por-link
  documentado.
- **QA-39 — Prefetch não ativa.** `curl.exe` 5x no link vivo → depois o clique
  no browser funciona normal (prova GET sem efeito; cobre Steam
  preview/antivírus).
- **QA-40 — POST sem Origin.** `curl.exe -X POST "LINK"` → `403` (CSRF
  fail-closed; o form legítimo sempre manda Origin same-origin).

## 9. Avatar dropdown: prefetch + skeleton (anti-CLS)

Pré-condição: logado (avatar visível), DevTools aberto (aba Network +
Performance → Experience). Vale em qualquer estado (`none`/`pending`/`active`).

- **QA-41 — Abertura sem salto de layout (SSR-seed + skeleton).** Recarregue
  a página e abra o dropdown **sem passar o mouse antes** (Tab até o avatar
  + Enter, ou toque direto no mobile). Esperado: o painel já abre com o
  conteúdo real (semente do servidor, sem flash) — ou, se a leitura do
  servidor falhou, com um placeholder pulsante **sem texto** que quase não
  se move quando o conteúdo chega. Na gravação do Performance (Slow 4G),
  **nenhum** evento `LayoutShift` relevante aparece na abertura (o `min-h`
  do skeleton foi medido por locale; `ru`/`de` no estado `none` podem
  deslocar ~40–70px para baixo no caminho sem semente — residual aceito e
  documentado no cabeçalho de `WatchManagerSkeleton.tsx`).
- **QA-42 — Hover esquenta o painel (abre com conteúdo).** Passe o mouse no
  avatar ~1s e só então clique: o painel deve abrir **direto no conteúdo
  real**, sem flash de skeleton. Na aba Network: um `GET
  /api/watch/status` no hover + um no open (revalidação do mount — normal,
  barato e idempotente). Repetir hover/clique em sequência não multiplica
  requests (single-flight + TTL 15s) e fechar/reabrir rápido durante uma
  ativação `pending → active` toca o toast `Watch active!` **exatamente 1x**.

## 10. Mapa automatizado (não reteste na mão)

| Caso                                                                                                           | Suite                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate (amizade sem clique nunca ativa; confirmada ativa; legado ativa) em SQL real                              | `db.test.ts` + `db.integration.test.ts`                                                                                                                                                   |
| Ramo reconcile (confirmado→ativa+welcome; não-confirmado→só link; falha isolada)                               | `reconcile.test.ts`                                                                                                                                                                       |
| Split de envio (dedupe, race, sem welcome indevido)                                                            | `activationMessage.test.ts`                                                                                                                                                               |
| GET nunca consome/ativa; POST consome+ativa+welcome+session; 403/405/429; sela-falha→ok                        | `confirm/route.test.ts`                                                                                                                                                                   |
| Pollers (envio, drops, retry-até-cap, throttle, recheck anti-nag, overlap, offline-skip)                       | `welcomePoller` + `confirmExpiryPoller` + `confirmResendPoller` .test.ts                                                                                                                  |
| Resend route (401/403/405/429, queued true/false, 500 alto) + status `confirmExpired` (4 estados + degradação) | `confirm-resend/route.test.ts`, `status/route.test.ts`                                                                                                                                    |
| Resend UI, logout nos 3 estados, hook, paridade i18n ×5                                                        | `WatchManager.test.tsx`, `useWatchStatus.test.ts`, `watchLocales.test.ts`                                                                                                                     |
| Inbox rico (detalhe por sessão, selo cheater, contador mensal, teaser do bot)                                   | `WatchInbox.test.tsx`, `notifications/route.test.ts`, `db.test.ts`, `db.integration.test.ts`, `notificationText.test.ts`, `notifyMessage.test.ts`, `e2e/watch.spec.ts` (chained journey) |
| Journey mockada (aceite→pending sem toast; POST→active; expirado→resend)                                       | `e2e/watch.spec.ts` (3 testes novos)                                                                                                                                                      |
| Comandos                                                                                                       | `pnpm test` · `pnpm test -- --runTestsByPath <arq>` · `pnpm run lint` · `pnpm exec tsc --noEmit` · `pnpm exec playwright test e2e/watch.spec.ts --project=chromium` · `pnpm run db:smoke` |

## 11. Checklist final de aceite

- [ ] QA-01→QA-06 verdes (feliz, logout 3 estados, opt-out + re-signup)
- [ ] QA-41→QA-42 verdes (skeleton sem salto em cold open; hover abre com conteúdo, 1 toast)
- [ ] QA-07→QA-09: gating provado (amizade sem clique = pending; GETs não
      gastam; clique ativa tudo)
- [ ] QA-10: aviso de expirado 1x com texto exato do idioma; QA-11:
      clicado-a-tempo nunca recebe aviso
- [ ] QA-12→QA-14: gerar-novo funciona; throttle = 1 mensagem; aceite-tardio se
      auto-cura
- [ ] QA-15→QA-25 sem surpresa (em especial QA-17 single-use e QA-38 tradeoff)
- [ ] QA-26→QA-40 cobertos ou conscientemente pulados
- [ ] QA-43 verde (detalhe por sessão + selo cheater + badge mensal; chat só teaser)
- [ ] §7 em ao menos en+pt (ideal 5)
- [ ] Banco confere em cada transição (§0.2, SQLs)
- [ ] `pnpm run lint`, `tsc`, `pnpm test`, e2e watch verdes
- [ ] `.env` de QA sem segredos commitados; nada testado contra produção
