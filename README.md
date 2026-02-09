# Solana Token Buyer CLI Bot

CLI-бот для покупки токенов на Solana через Jupiter V6 aggregator. Включает on-chain валидацию, anti-scam проверки, анализ пулов и механизмы безопасности транзакций.

## Установка

```bash
npm install
cp .env.example .env
# Заполните .env — RPC URL и приватный ключ
```

### Переменные окружения

| Переменная | Обязательная | По умолчанию | Описание |
|---|---|---|---|
| `SOLANA_RPC_URL` | Да | — | Solana RPC endpoint |
| `PRIVATE_KEY` | Да* | — | Base58 (Phantom) или JSON array (solana-keygen) |
| `PRIVATE_KEY_PATH` | Да* | — | Путь к файлу ключа (альтернатива `PRIVATE_KEY`) |
| `BUY_AMOUNT_SOL` | Да | — | Сколько SOL тратить |
| `SLIPPAGE_BPS` | Нет | `500` | Проскальзывание (500 = 5%) |
| `PRIORITY_FEE` | Нет | `auto` | Priority fee в lamports или `"auto"` |
| `MAX_BUY_SOL` | Нет | `10` | Максимум SOL на одну покупку (safety cap) |

\* Используйте либо `PRIVATE_KEY`, либо `PRIVATE_KEY_PATH` — не оба.

### RPC

Публичный RPC (`https://api.mainnet-beta.solana.com`) имеет лимиты. Для продакшена:
- [Helius](https://helius.dev)
- [QuickNode](https://quicknode.com)
- [Alchemy](https://alchemy.com)

## Использование

```bash
# Базовая покупка
npm start <TOKEN_MINT>

# Dry run — анализ без выполнения свопа
npm start <TOKEN_MINT> --dry-run

# Своя сумма
npm start <TOKEN_MINT> --amount 0.5

# Процент от баланса кошелька
npm start <TOKEN_MINT> --percent 50

# Без подтверждений (авто-режим)
npm start <TOKEN_MINT> --yes

# Комбинация флагов
npm start <TOKEN_MINT> --amount 0.1 --dry-run --yes
```

## Поток транзакции

Бот выполняет эти шаги по порядку. У каждого шага конкретная задача безопасности:

```
 1. CLI Args & Config     → Парсинг флагов, загрузка .env, валидация входных данных
 2. RPC Warmup            → Установка keep-alive соединения, проверка баланса
 3. Network Detection     → Определение mainnet/devnet/testnet по genesis hash
 4. Priority Fee Estimate → Запрос недавних комиссий для оптимальной цены транзакции
 5. On-chain Validation   → Проверка что token mint существует и инициализирован
 6. Pool Analysis         → Поиск пулов через DexScreener + on-chain верификация
 7. Jupiter Quote         → Получение котировки со slippage protection
 8. Anti-Scam Checks      → Парсинг Token-2022 расширений, симуляция honeypot
 9. Confirmation          → Человеко-читаемая сводка, подтверждение от пользователя
10. Quote Freshness       → Перекотировка если >10с, отмена при >10% падении цены
11. Execute Swap          → Отправка транзакции с retry + повышением fee при таймауте
12. Result                → TX signature + ссылки на explorer
```

### Почему каждый шаг важен

**Шаг 2 — RPC Warmup**: 4 RPC вызова (`getVersion`, `getSlot`, `getLatestBlockhash`, `getBalance`) через одно keep-alive TCP соединение. Гарантирует "горячее" соединение до time-sensitive swap транзакции, экономя ~200-500мс.

**Шаг 3 — Network Detection**: Сравнивает genesis hash RPC-ноды с известными значениями. Предотвращает случайное использование реальных средств на mainnet. Требует явного подтверждения на mainnet.

**Шаг 5 — On-chain Validation**: Читает сырые 82 байта SPL Mint account data. Проверяет:
- Account принадлежит Token Program или Token-2022
- Mint инициализирован
- Предупреждает если mint authority установлен (риск инфляции)
- Предупреждает если freeze authority установлен (риск чёрного списка)

**Шаг 7 — Jupiter Quote**: Jupiter V6 `ExactIn` котировка. Поле `otherAmountThreshold` — это фактический `amountOutMin`, отправляемый в swap. Это и есть slippage protection. Jupiter рассчитывает его как: `outAmount * (10000 - slippageBps) / 10000`.

**Шаг 8 — Anti-Scam Checks**: Для Token-2022 токенов парсит TLV расширения начиная с байта 83:
- **TransferFeeConfig** (type 1): Обнаружение buy/sell tax. >10% помечается как EXTREME.
- **PermanentDelegate** (type 12): Может перевести/сжечь чужие токены.
- **NonTransferable** (type 9): Soulbound — нельзя продать никогда.
- **TransferHook** (type 14): Кастомная программа на каждый трансфер — может отклонять продажи.
- **Honeypot симуляция**: Запрашивает обратную котировку (TOKEN→SOL). Если Jupiter не может построить маршрут — токен может быть непродаваемым. Round-trip потеря >50% помечается как extreme.

**Шаг 10 — Quote Freshness**: Если пользователь потратил >10с на подтверждение, котировка может устареть. Бот перекотирует и сравнивает. Если новая цена хуже >10%, отменяет (если нет `--yes`).

**Шаг 11 — Retry с повышением Fee**: При таймауте или истечении blockhash бот повторяет до 3 раз с увеличением priority fee в 1.5x. Это предотвращает застревание транзакций при загруженности сети.

## Архитектура

```
src/
├── index.js          Главная точка входа, оркестрация всего потока
├── config.js         Загрузка .env, управление ключами, детекция сети
├── validate.js       Валидация адресов Solana (base58, длина)
├── http.js           Общий axios instance с keep-alive agents
├── retry.js          Экспоненциальный backoff для transient ошибок
├── logger.js         Цветной вывод в консоль с timestamps
├── dexscreener.js    Клиент DexScreener API (поиск пулов)
├── poolSelector.js   Фильтрация, скоринг и ранжирование пулов
├── onchain.js        On-chain валидация token mint и пулов
├── fees.js           Оценка network priority fee из недавних слотов
├── jupiter.js        Jupiter V6 quote + swap с retry логикой
└── antiscam.js       Парсинг Token-2022 расширений, детекция honeypot
```

### Ключевые архитектурные решения

**Jupiter управляет роутингом, не мы.** Бот делегирует все решения по роутингу (какой AMM, какой путь, multi-hop) Jupiter aggregator. Анализ пулов через DexScreener — чисто информационный. Показывает какие пулы существуют, но не ограничивает роутинг Jupiter.

**Нет v2/v3/v4 разделения в коде.** Так как Jupiter абстрагирует все AMM (Raydium v4, Orca Whirlpool/CLMM, Meteora DLMM, Phoenix), в нашем коде нет AMM-специфичной логики. Тип пула (v2/v3) логируется из DexScreener labels, но не влияет на выполнение.

**Нет infinite approvals.** Jupiter V6 swap API использует одну атомарную транзакцию. Нет отдельного шага `approve` — SOL оборачивается и свопится в одной транзакции. Никакие approvals не остаются висеть.

**Целочисленная арифметика для SOL→lamport.** `solToLamports()` использует split строки + parseInt, а не `parseFloat() * 1e9`. Это исключает ошибки округления float (пример: `0.29 * 1e9 = 289999999.99999997`).

**Приватный ключ никогда не сериализуется.** `createSafeConfig()` переопределяет `toJSON()` и `util.inspect` чтобы редактировать keypair. Даже если config случайно залогирован, виден только public key.

**Добавление новой сети невозможно без рефакторинга.** Весь бот привязан к Solana: `@solana/web3.js`, Jupiter API, SPL Token layout, Token-2022 парсинг. Другая сеть (EVM/BSC) — это фактически другой проект.

**Подключение другого источника пулов** возможно с адаптером. `dexscreener.js` изолирован, но `poolSelector.js` ожидает формат DexScreener. Нужен нормализующий слой для другого API.

## Exit Codes

| Code | Константа | Значение |
|---|---|---|
| 0 | `SUCCESS` | Swap выполнен или dry-run завершён |
| 1 | `BAD_ARGS` | Невалидные аргументы CLI |
| 2 | `CONFIG_ERROR` | Ошибка конфигурации .env |
| 3 | `RPC_ERROR` | RPC соединение не удалось |
| 4 | `INSUFFICIENT_FUNDS` | Недостаточно SOL |
| 5 | `QUOTE_ERROR` | Jupiter quote не удался |
| 6 | `SWAP_ERROR` | Транзакция провалилась |
| 7 | `USER_CANCELLED` | Пользователь отменил |
| 8 | `TOKEN_INVALID` | Token mint невалиден on-chain |
| 9 | `PRICE_DEVIATION` | Цена сдвинулась >10% между котировкой и исполнением |
| 10 | `SCAM_DETECTED` | Обнаружен критический anti-scam риск |

## Диагностика ошибок

Когда swap проваливается on-chain, бот логирует:
- Разобранное сообщение об ошибке (напр. "Slippage tolerance exceeded" вместо сырого `{Custom: 6001}`)
- TX signature со ссылкой на Solscan (можно посмотреть проваленную транзакцию)
- Transaction logs (последние 10 строк из `getTransaction`)
- Полный контекст: токен, сумма, slippage, ожидаемый output, минимальный output

## Ссылки на транзакции

После успешного свопа бот выводит:
```
TX Signature: <base58_signature>
Solscan:          https://solscan.io/tx/<signature>
Solana Explorer:  https://explorer.solana.com/tx/<signature>
```

Эти ссылки корректны потому что:
- Signature — это возврат из `connection.sendRawTransaction()`, реальный on-chain transaction ID
- Solscan и Solana Explorer индексируют транзакции по этому signature
- Транзакция подтверждена с `confirmed` commitment до показа ссылки
- При провале ссылка на Solscan всё равно показывается — проваленная транзакция видна в explorer для дебага

При провале свопа бот дополнительно выводит:
```
TX (failed): https://solscan.io/tx/<signature>
```
Это позволяет проверить точную причину провала через explorer: какая инструкция провалилась, какие логи оставила программа, и какие были балансы на момент транзакции.

## Тестирование

```bash
# Все тесты
npm test

# Конкретный suite
npx jest tests/integration.test.js

# С coverage
npx jest --coverage
```

### Структура тестов

| Suite | Что покрывает |
|---|---|
| `config.test.js` | Загрузка конфига, форматы ключей, детекция сети, safe serialization |
| `validate.test.js` | Валидация адресов Solana (base58 charset, длина) |
| `retry.test.js` | Exponential backoff, retryable vs non-retryable ошибки |
| `dexscreener.test.js` | Парсинг API ответов, фильтрация по chain |
| `poolSelector.test.js` | Фильтрация пулов, композитный скоринг, ранжирование |
| `onchain.test.js` | Парсинг mint data, валидация токенов, проверка пулов |
| `fees.test.js` | Оценка priority fee, расчёт перцентилей |
| `jupiter.test.js` | Получение котировки, исполнение swap, retry с fee bumping |
| `antiscam.test.js` | Token-2022 расширения, honeypot симуляция, risk assessment |
| `integration.test.js` | Полный поток: dry-run, swap, error exits, порядок шагов |

190 тестов, 10 test suites.

## Безопасность

- **Никогда** не коммитьте `.env` с приватным ключом
- Используйте `PRIVATE_KEY_PATH` с `chmod 600` для лучшей защиты ключа
- Бот предупреждает если `.env` файл читаем другими (Unix)
- Начинайте с малых сумм (`BUY_AMOUNT_SOL=0.001`) и `--dry-run`
- На mainnet бот требует явного подтверждения (или `--yes`)
- `MAX_BUY_SOL` ограничивает максимальную сумму (по умолчанию 10 SOL)
- Anti-scam проверки автоматически блокируют критически рискованные токены
