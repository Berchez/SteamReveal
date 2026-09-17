# QA Core — Watch happy path (bot com conta limitada)

Versão resumida de `WATCH_MANUAL_QA.md`: só o núcleo feliz
(amizade → login → notify → inbox → opt-out), mais a lane legada
(Start → link → clique) para o re-watch pós-opt-out.
Casos de borda, expiração, throttling, erros, i18n e segurança ficam no
doc completo — ver "Fora de escopo" no fim.

> Modelo single-state: usuário novo deslogado NUNCA aperta Start — a
> ordem é **adicionar o bot PRIMEIRO, entrar DEPOIS** (o login já ativa
> direto, sem pending/link). A lane Start→pending→link→clique segue viva
> só para o re-watch pós-opt-out (o cookie sobrevive ao unfriend) e para
> tokens legados — QA-C02/C03 cobrem essa lane.

> Escopo: comportamento observável com contas Steam reais + banco Turso
> de DEV. **Nunca rode contra produção.**

---

## 0. Pré-requisitos

| #   | Item              | Detalhe                                                                                                                                                                                                                        |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 2 contas Steam    | **Bot** (pode ser **limitada**: sem gasto de US$5 — ela nunca precisa *enviar* convite neste roteiro, só receber/aceitar e conversar) + **testador FULL** (precisa *enviar* o pedido de amizade para o bot). Use só contas próprias. |
| 2   | Banco Turso de DEV | Crie um só para isso. **Nunca contra produção.**                                                                                                                                                                               |
| 3   | `.env` local      | `DATABASE_URL` + `DATABASE_TOKEN` (DEV); `SESSION_SECRET` com 32+ chars; `STEAM_BOT_USERNAME`, `STEAM_BOT_PASSWORD`, `STEAM_BOT_SHARED_SECRET`; `WATCH_SITE_URL=http://localhost:3000`; `STEAM_API_KEY` opcional (sem ela o avatar cai em fallback de letra, o fluxo funciona). `DEV_TEST_MODE` **desligado/ausente**. |
| 4   | Primeira vez      | `pnpm run start:bot` interativo e aprove o Steam Guard no celular (ver `WATCH_BOT_RUNBOOK.md` §3). Anote o **perfil/ID64 do bot** — o testador vai adicioná-lo direto pela URL (contas limitadas podem não aparecer na busca de amizade). |
| 5   | Migração          | `pnpm run db:migrate` → `✔ All migrations applied.`                                                                                                                                                                            |
| 6   | Subir tudo        | Terminal 1: `pnpm run dev` (`:3000`). Terminal 2: `pnpm run start:bot`.                                                                                                                                                         |

Sem aceleração de TTL (só serve para testes de expiração, fora deste roteiro).

### 0.1. A direção da amizade (leia antes de começar)

Conta limitada **não envia** convites, mas **aceita** os recebidos — e no
modelo single-state a direção é exatamente essa: **o testador adiciona o
bot** (pedido inbound), o bot aceita sozinho via `addFriend` (limite
diário 50 + teto 240 amigos — ver runbook §5), e o login prova a amizade.
Nenhum convite do bot é necessário na lane nova.

**Caminho A — com o bot ligado (comece por aqui):**

1. Na Steam do **testador**, abra o **perfil do bot pela URL direta** e
   envie o pedido de amizade.
2. Aguarde ~1 min: log do bot mostra `accepted inbound friend request
   (... friends=... acceptedToday=...)`. Confira a amizade nas duas contas.
3. Faça o login no site (QA-C01 abaixo) — cai `active` direto.

**Caminho B — fallback determinístico (se o A não convergir em ~3 min):**

1. **Pare o bot** (`Ctrl+C`).
2. Na conta do **bot** (cliente Steam ou mobile), **aceite manualmente** o
   pedido pendente do testador.
3. **Suba o bot** de novo e faça o login — o gate lê a amizade via
   `GetFriendList` e ativa direto.

**Ruído esperado (não é bug):** se o bot bater o teto/diário, os logs
mostram `friend-accept REFUSED` / `sweep paused` — nesse caso o pedido fica
pendente para o próximo sweep/dia, não é perda. Com `.env` default
(240/50) isso só acontece sob burst — em QA normal, nunca.

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
   `friend-remove`. Liveness: `pnpm run healthcheck:bot`.

### 0.3. Reset entre ciclos (faça sempre)

1. Na Steam do testador: **desfazer amizade com o bot** (remove
   `watched_profiles` + `accounts` atomicamente).
2. No site: avatar → **Sign out** (mata o cookie).
3. Confira no banco: os dois `SELECT`s acima voltam vazios.

---

## 1. QA-C01 — Amizade → login → active direto (lane nova, sem Start)

1. Navegador limpo: `http://localhost:3000/en` → mostra o cluster
   deslogado (**Add the SteamReveal bot** + **Sign in**), sem sino/avatar.
2. **Negativo primeiro (30 segundos, vale ouro):** clique **Sign in**
   SEM ter adicionado o bot → volta em `/en/?auth=nofriend` + toast
   "Add the SteamReveal bot as a friend on Steam first" — e SEGUE
   deslogado (sem avatar, sem cookie `steamreveal_watch_session`). Prova
   que o gate barra sem amizade.
3. **Adicione o bot** na Steam do testador (perfil pela URL direta, §0.1)
   e aguarde o `accepted inbound friend request` no log.
4. **Sign in with Steam** (conta testadora) → volta logado com o toast
   `Watch active! ...` (landing `?watch=new`, some sozinho; reload não
   repete) e o avatar aparece.
5. Abra o avatar → heading `Watching` (nunca `Invite sent` — não houve
   Start). Banco: `watched_profiles.status='active'` + `activated_at`;
   `accounts.last_login_at` preenchido.
6. Cookie `steamreveal_watch_session` presente.

## 2. QA-C02 — Página de confirmação, lane legada (só o clique confirma)

> Lane legada / re-watch: depois do QA-C06 (opt-out) MANTENHA o cookie
> (não faça Sign out) — a sessão sobrevivente mostra `Watch a Steam
> profile` + Start, e é nela que esta lane vive. Em conta nova deslogada
> esta lane é inalcançável (o login já ativa direto).

1. No dropdown, clique `Watch your profile` → heading `Invite sent`
   (banco: `pending`).
2. Na Steam, aceite o convite do bot → chega o link no chat (template de
   confirmação no seu idioma). Banco: `confirm_token_hash` com 64 hex
   (**nunca o token plano**), `confirm_expires_at` ≈ agora+24h.
3. Abra o link → página `Confirm your Watch request` com o botão
   `Confirm and activate`. **Nada acontece sozinho**: abra, recarregue,
   troque de aba e volte — sem clique, sem POST, token intacto.
4. Desligue o JS e repita num ciclo fresco: a mesma página/botão
   funcionam (nenhum elemento `<script>` — só o guard inline `onsubmit`
   anti-duplo-clique, inerte sem JS) e recarregar (F5) 2x não gasta nada.
5. Banco (antes de qualquer POST): `confirmed_at` NULL, `status` pending,
   hash inalterado.

## 3. QA-C03 — O clique ativa tudo (lane legada)

1. Na página do QA-C02, clique `Confirm and activate`.
2. **Esperado:** redirect `/en/?confirmed=ok` + toast
   `Watch confirmed! You will be notified here whenever your profile is searched.`
   (some sozinho; reload não repete).
3. Banco: `confirmed_at` preenchido + token zerado; `status='active'` +
   `activated_at`; evento `kind='welcome'` → `sent`.
4. Em ~20s: toast
   `Watch active! The bot will message you on Steam when this profile is searched.` +
   dropdown vira `Watching`.
5. No chat: `SteamReveal Watch is now active for your profile...`.
6. Cookie `steamreveal_watch_session` presente.

## 4. QA-C04 — Busca gera notify → sino → inbox

1. Com watch `active`, busque o perfil **digitando a URL direto** (não pelo
   link do bot — pelo link a busca é suprimida pelo token anti-loop).
2. Em ~1 min (poll de 60s): mensagem no chat + sino com badge `1 unread`.
3. Abra o sino: item listado, badge zera, reload mantém zerado.
4. Banco: `kind='notify'` → `sent`; `last_notified_at` preenchido.
5. **Opcional (custa 1 busca a mais):** repita a busca e **abra o relatório
   de cheater** nela → o item novo no sino mostra a linha da sessão com
   data da busca + `Cheater report opened` (ou equivalente no idioma).
6. **Cooldown (só leitura):** busque de novo → **nada por 24h** (teto de
   1 aviso/dia; o sino, sem throttle, lista normalmente). Para retestar
   sem esperar:
   `UPDATE watched_profiles SET last_notified_at='2000-01-01T00:00:00.000Z' WHERE steam_id='<ID64>'`.

## 5. QA-C05 — Logout rápido

Para `none`, `pending` e `active`: avatar → **Sign out** → volta `Sign in`,
sino some, cookie some.

## 6. QA-C06 — Opt-out + re-signup fresco

1. Com tudo ativo: na Steam do testador, **desfaça a amizade com o bot**.
2. Banco: **as duas linhas sumiram**. Dropdown volta a
   `Watch a Steam profile`. Novas buscas não notificam.
3. Sem fazer Sign out (sessão sobrevivente): clique `Watch your profile`
   → ciclo legada recomeça **não-confirmado** (QA-C02/C03: novo convite,
   aceite na Steam, novo link, clique). Alternativa: Sign out → adicione
   o bot de novo (§0.1) → Sign in → lane nova ativa direto (QA-C01).

---

## Checklist final de aceite (core)

- [ ] QA-C01 verde (sem amizade → `auth=nofriend` sem sessão; com amizade → login ativa direto + toast `watch=new`, sem Start)
- [ ] QA-C02 verde (lane legada: só o clique confirma; sem JS o form sobrevive a reloads)
- [ ] QA-C03 verde (`confirmed_at` + `active` + welcome no chat + toast)
- [ ] QA-C04 verde (notify no chat + item no sino + badge zera; cooldown só no bot)
- [ ] QA-C05 verde (logout nos 3 estados)
- [ ] QA-C06 verde (opt-out apaga as linhas; re-watch via Start com sessão sobrevivente OU via lane nova com re-login)
- [ ] Banco confere em cada transição (§0.2, SQLs)

## Fora de escopo (no doc completo `WATCH_MANUAL_QA.md`)

- Expiração/aviso/resend/throttle (QA-10→QA-14) — exige TTL acelerado (§0.1 de lá)
- Matriz de erros e bordas (QA-15→QA-25), sessões/logout avançado (QA-26→QA-28)
- Bot desligado, re-friending, double-start, 7 dias (QA-29→QA-37)
- Matriz de idiomas §7 (mínimo en+pt quando for cobrir)
- Segurança aceita §8 (link encaminhado, prefetch, POST sem Origin)
- Skeleton/prefetch do dropdown §9 (QA-41→QA-42)
- Mapa automatizado §10 (o que já é coberto por Jest/Playwright — não retestar na mão)
