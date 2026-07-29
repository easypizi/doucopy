# Как подключить машины к doucopy

Три сценария:

1. Ты владелец: разворачиваешь relay и подключаешь первую машину.
2. У тебя уже всё работает, добавляешь новую свою машину.
3. Приглашаешь кого-то ещё в свой круг.

Везде:

- `APP` — имя Heroku-приложения (у меня по умолчанию `mcp-ivan-connector`).
- `RELAY` — URL задеплоенного relay, `https://<APP>-XXXX.herokuapp.com`. Точный адрес печатается после `make deploy` и в `heroku apps:info -a <APP>`.
- Пакет опубликован в npm как `doucopy`. Бинарник называется `agent-link` (и `doucopy`, как алиас), запуск без установки: `npx doucopy ...`.
- Требования: Node.js 22.x, macOS (для демона-респондера), один из CLI: `cursor-agent`, `claude` или `codex` в PATH (если хочешь отвечать, а не только спрашивать).

---

## Сценарий 1. Владелец: relay + первая машина

Один раз за проект. Тебе нужен клон репо (relay деплоится через `git push heroku`, из npm это не работает).

```bash
git clone https://github.com/easypizi/pshpsh ~/dev/doucopy
cd ~/dev/doucopy
make install && make build
heroku login
make setup
```

`make setup` спросит имя приложения, задеплоит relay, сгенерирует bootstrap-инвайт на 24 часа и сразу запустит визард `join` для этой же машины. Тебе нужно только:

- ввести имя приложения (проверяется на уникальность),
- ввести имя пира для машины (по умолчанию — hostname),
- отметить где авторизоваться (Cursor / Claude Code / Codex),
- выбрать харнесс-респондер (или `asker-only`),
- согласиться на установку скиллов и, если хочешь, вписать `Never reveal`-слова.

После завершения перезапусти свой AI-клиент, чтобы он подхватил MCP-сервер.

Сохранённый инвайт больше не нужен, но если планируешь звать других людей — из этой же машины можно позже сделать `make invite-bootstrap APP=<APP>`.

---

## Сценарий 2. Добавить ещё одну свою машину

На уже настроенной машине:

```bash
make invite TTL=48
```

Или, если хочешь инвайт покрепче (через `RELAY_SECRET` с Heroku, а не через локальный токен):

```bash
make invite-bootstrap APP=<APP>
```

Скопируй строку `ali1.eyJ...`.

На новой машине никакой клон не нужен, всё через npx:

```bash
npx doucopy join <RELAY> <invite>
```

Визард спросит:

- имя пира (по умолчанию hostname без `.local`),
- где авторизоваться (мультивыбор Cursor / Claude Code / Codex, предотмечены найденные),
- какой харнесс отвечает или `asker-only`,
- ставить ли скиллы глобально,
- слова которые ответчик не должен выдавать (пиши через запятую, Enter — пропустить).

Дальше визард сам записывает `~/.agent-link/config.json`, `~/.agent-link/policy.md`, мерджит MCP-конфиги выбранных клиентов, ставит и запускает демона (если выбран респондер) и ждёт `online`. Перезапусти свой AI-клиент.

Повторный запуск. `npx doucopy join` (или `make join` в чекауте) можно вызывать без аргументов сколько угодно раз:

- Если машина уже подключена — визард предлагает переиспользовать существующего пира и токен, проведя только через askers / responder / skills / policy заново.
- Если предыдущий запуск прервали после ввода URL и invite — они предзаполнятся из черновика `~/.agent-link/join-draft.json` (TTL 48h, удаляется при успехе).

Неинтерактивно (для скриптов):

```bash
npx doucopy join <RELAY> <invite> \
  --name laptop-mbp --harness cursor-agent --askers cursor,claude \
  --never-reveal "AcmeCorp,project-yellowstone" --yes
```

---

## Сценарий 3. Пригласить кого-то ещё

Точно то же, что сценарий 2, только другой человек. С твоей машины: `make invite TTL=48`, шлёшь ему `RELAY` и `invite`. Он запускает `npx doucopy join <RELAY> <invite>` и проходит визард.

Каждый пир видит другого через `list_peers` в MCP или `npx doucopy chat` в терминале.

---

## Ежедневное использование

Через AI-агента:

```
list_peers
ask_peer(peer="work-mbp", question="Что я решил про биллинг?")
ask_peer(peer="work-mbp", question="А про триал?", conversation_id="<тот же>")
check_reply(ticket_id="…")
```

Через терминал:

```bash
npx doucopy chat                       # REPL: цветная таблица пиров, /use <peer>, дальше просто печатай
npx doucopy status                     # демон, пиры, диалоги, паузы
npx doucopy policy                     # открыть policy.md в $EDITOR
npx doucopy logs -f                    # логи респондера
npx doucopy pause work-mbp --for 2h    # временно не отвечать пиру
npx doucopy resume work-mbp
```

В репо-чекауте всё то же самое через `make chat`, `make status`, `make policy` и т.д. — см. `make help`.

### Один файл фильтра — policy.md

`~/.agent-link/policy.md` — единственное место, где ты рулишь тем что ответчик может и не может говорить:

- Верх файла — инструкция LLM.
- Секция `## Never reveal` — жёсткая пост-фильтрация в коде демона (после LLM). Буллеты — регистронезависимые литералы, `/pattern/` — регулярки.

Правки подхватываются на следующий вопрос, рестарт не нужен. Открыть: `npx doucopy policy`.

### Counter-questions

Ответчик может задать ровно один уточняющий вопрос в том же диалоге. Если ждёшь его — вызывай `ask_peer` с `timeout_seconds: 240`. Лимиты relay: hops ≤ 1, до 4 открытых тикетов на диалог.

---

## Диагностика

- `npx doucopy status` показывает `HTTP 401: unauthorized` — токен протух или ротирован `RELAY_SECRET`. Удали `~/.agent-link/config.json`, возьми новый инвайт (`make invite-bootstrap APP=<APP>`), заново `npx doucopy join`.
- `list_peers` не видит никого — проверь что демон запущен на обоих концах (`npx doucopy status`), проверь что AI-клиент перезапущен после `join`, посмотри `npx doucopy logs -f`.
- Пир висит offline — он не пинговал relay >60с. Вопрос всё ещё в очереди 24 часа, забери позже через `check_reply`.
- `make deploy` жалуется на heroku CLI — `brew install heroku && heroku login`, потом `heroku git:remote -a <APP>`.

---

## Capacity

Relay рассчитан на маленький доверенный круг машин, десятки, не тысячи:

- Каждый онлайн-демон держит один long-poll (25с) — 10 демонов это 10 idle-сокетов.
- Авторизация stateless HMAC, никакой таблицы пользователей.
- Всё состояние (тикеты, presence) в памяти одного инстанса. Рестарт роняет незабранные тикеты, горизонтального масштабирования нет.
