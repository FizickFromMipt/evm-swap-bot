# BSC Token Buyer CLI Bot

CLI-бот для покупки токенов на BSC (BNB Smart Chain) через 0x Swap API v2 (агрегатор 50+ DEX). Включает on-chain валидацию ERC20 токенов, anti-scam проверки (honeypot, proxy, ownership), анализ пулов через DexScreener и механизмы безопасности транзакций.

## Установка

```bash
npm install
cp .env.example .env
# Заполните .env — RPC URL, приватный ключ, 0x API key
```

### Переменные окружения

| Переменная | Обязательная | По умолчанию | Описание |
|---|---|---|---|
| `RPC_URL` | Да | — | BSC RPC endpoint (например `https://bsc-dataseed.binance.org/`) |
| `PRIVATE_KEY` | Да* | — | Hex-строка (с или без `0x` префикса) |
| `PRIVATE_KEY_PATH` | Да* | — | Путь к файлу ключа (альтернатива `PRIVATE_KEY`) |
| `ROUTER_ZERO_X_API_KEY` | Да | — | API ключ 0x (получить на https://0x.org/docs/introduction/getting-started) |
| `ZEROX_API_URL` | Нет | `https://api.0x.org` | Базовый URL 0x API |
| `BUY_AMOUNT_BNB` | Да | — | Сколько BNB тратить на покупку |
| `SLIPPAGE_PERCENT` | Нет | `5` | Проскальзывание в процентах (конвертируется в bps для 0x API) |
| `GAS_LIMIT` | Нет | `300000` | Fallback gas limit (0x API обычно возвращает свой) |
| `MAX_GAS_PRICE_GWEI` | Нет | `5` | Максимальная цена газа в gwei (safety cap) |
| `BUY_RETRIES` | Нет | `3` | Количество повторов при ошибке получения котировки |
| `BUY_RETRY_DELAY_MS` | Нет | `500` | Задержка между повторами в мс |
| `SIMULATE_BEFORE_BUY` | Нет | `false` | Симулировать swap перед покупкой |
| `MAX_BUY_BNB` | Нет | `1` | Максимум BNB на одну покупку (safety cap) |
| `MIN_LIQUIDITY_USD` | Нет | `1000` | Минимальная ликвидность пула в USD |
| `MAX_TOKEN_AGE_SEC` | Нет | `300` | Максимальный возраст токена в секундах |
| `POLL_INTERVAL_MS` | Нет | `3000` | Интервал опроса DexScreener в мс |

\* Используйте либо `PRIVATE_KEY`, либо `PRIVATE_KEY_PATH` — не оба.

### RPC

Публичный BSC RPC (`https://bsc-dataseed.binance.org/`) имеет лимиты. Для продакшена:
- [QuickNode](https://quicknode.com)
- [Ankr](https://ankr.com)
- [NodeReal](https://nodereal.io)
- BSC альтернативные dataseed: `https://bsc-dataseed1.defibit.io/`, `https://bsc-dataseed1.ninicoin.io/`

## Использование

```bash
# Базовая покупка
npm start <TOKEN_ADDRESS>

# Dry run — анализ без выполнения свопа
npm start <TOKEN_ADDRESS> --dry-run

# Своя сумма
npm start <TOKEN_ADDRESS> --amount 0.05

# Без подтверждений (авто-режим)
npm start <TOKEN_ADDRESS> --yes

# Комбинация флагов
npm start <TOKEN_ADDRESS> --amount 0.1 --dry-run --yes

# Continuous mode — мониторинг новых токенов
npm start --continuous
```

## Поток транзакции

```
 1. CLI Args & Config     -> Парсинг флагов, загрузка .env, валидация входных данных
 2. RPC Connection        -> Подключение к BSC, определение chainId (56/97)
 3. Balance Check         -> Проверка баланса BNB, сравнение с суммой покупки
 4. Gas Price             -> Получение текущей цены газа, применение cap из конфига
 5. On-chain Validation   -> Чтение ERC20 контракта (name, symbol, decimals, totalSupply)
 6. Pool Analysis         -> DexScreener API -> фильтрация и скоринг пулов
 7. Anti-Scam Checks      -> Honeypot simulation (0x /price), proxy detection, ownership check
 8. Confirmation          -> Сводка для пользователя, подтверждение
 9. Execute Swap          -> 0x Swap API /quote → wallet.sendTransaction() с retry логикой
10. Result                -> TX hash + ссылка на BscScan + route info (какие DEX)
```

### Почему каждый шаг важен

**Шаг 2 — RPC Connection**: Подключается к BSC через `ethers.JsonRpcProvider`. Определяет chainId: 56 = mainnet (предупреждение о реальных средствах), 97 = testnet. Предотвращает случайное использование средств в неправильной сети.

**Шаг 4 — Gas Price**: Получает текущую цену газа через `provider.getFeeData()`. Если цена превышает `MAX_GAS_PRICE_GWEI`, автоматически ограничивает. Защищает от переплаты за газ в периоды высокой нагрузки.

**Шаг 5 — On-chain Validation**: Читает ERC20 контракт через ethers.Contract. Получает name, symbol, decimals, totalSupply. Опционально проверяет `owner()` (Ownable). Если контракт не отвечает — токен невалиден.

**Шаг 6 — Pool Analysis**: DexScreener API возвращает все пулы для токена. Бот фильтрует:
- Только BSC (`chainId === 'bsc'`)
- Только доверенные DEX (PancakeSwap, BiSwap)
- Только ликвидные quote-токены (WBNB, USDT, USDC — tier 1; BUSD — tier 2)
- Только пулы с ненулевой ликвидностью

Затем применяет композитный скоринг (liquidity, volume, turnover, quote quality, tx activity) и выбирает лучший пул.

**Шаг 7 — Anti-Scam Checks**: Три независимые проверки:
- **Honeypot simulation**: Запрашивает 0x `/price` для пути BNB→Token и Token→BNB. Если обратный swap (sell) не возможен или теряет >50% — критический риск. >20% — высокий риск. 0x API также предоставляет `tokenMetadata.buyToken.sellTaxBps` — встроенную детекцию sell tax.
- **EIP-1967 Proxy Detection**: Читает storage slot `0x360894...`. Если установлен — контракт upgradeable, владелец может изменить логику.
- **Ownership Check**: Вызывает `owner()`. Если owner != `address(0)` — ownership не renounced, владелец может иметь привилегии.

**Шаг 9 — Execute Swap**: Запрашивает 0x Swap API `/quote` — агрегатор находит лучший маршрут через 50+ DEX на BSC (PancakeSwap, BiSwap, DODO, SushiSwap и др.), включая split-routing и multi-hop. Ответ содержит готовый calldata — бот вызывает `wallet.sendTransaction({ to, data, value })`. Slippage передаётся через `slippageBps` параметр в запросе. При ошибке повторяет до `BUY_RETRIES` раз (не повторяет on-chain revert).

## Архитектура

```
src/
├── index.js          Главная точка входа, оркестрация потока, CLI парсинг
├── config.js         Загрузка .env, ethers.Wallet, bnbToWei(), BSC и 0x константы
├── validate.js       Валидация EVM адресов (ethers.isAddress)
├── http.js           Общий axios instance с keep-alive agents
├── retry.js          Экспоненциальный backoff для transient ошибок
├── logger.js         Цветной вывод в консоль с timestamps
├── dexscreener.js    Клиент DexScreener API (поиск пулов)
├── poolSelector.js   Фильтрация, скоринг и ранжирование BSC пулов
├── onchain.js        On-chain ERC20 чтение (name, symbol, decimals, totalSupply)
├── fees.js           Получение gas price через provider.getFeeData()
├── swap.js           0x Swap API v2 — получение котировки и исполнение swap
└── antiscam.js       Honeypot simulation (0x /price), proxy detection, ownership check
```

### Ключевые архитектурные решения

**0x Swap API v2 агрегатор.** Бот использует 0x API для поиска лучшего маршрута через 50+ DEX на BSC (PancakeSwap, BiSwap, DODO, SushiSwap и др.). Агрегатор автоматически находит оптимальный путь, включая split-routing (разделение ордера между DEX) и multi-hop (промежуточные токены). Не требуется `ethers.Contract` — 0x API возвращает готовый calldata.

**Native BNB = `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`.** 0x API использует специальный адрес для native токена. Approve не нужен при свопе из BNB.

**Honeypot = roundtrip simulation через 0x /price.** Запрашиваем котировку для buy (BNB→Token) и sell (Token→BNB). Если sell quote не возможен — honeypot. Если round-trip loss экстремальный — скрытый tax. Бонус: `tokenMetadata.buyToken.sellTaxBps` — 0x API предоставляет встроенную детекцию sell tax.

**EIP-1967 proxy detection.** Читаем storage slot `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`. Если не нулевой — контракт является upgradeable proxy, владелец может изменить логику в любой момент.

**Целочисленная арифметика для BNB -> wei.** `bnbToWei()` использует split строки + padEnd, а не `parseFloat() * 1e18`. Это исключает ошибки округления float.

**Приватный ключ никогда не сериализуется.** `createSafeConfig()` переопределяет `toJSON()` и `util.inspect` чтобы редактировать wallet. Даже если config случайно залогирован, виден только адрес кошелька.

**ethers v6 с нативными BigInt.** Все суммы (wei, gas, amounts) — BigInt. Slippage конвертируется из процентов в bps (basis points) и передаётся напрямую в 0x API.

## Exit Codes

| Code | Константа | Значение |
|---|---|---|
| 0 | `SUCCESS` | Swap выполнен или dry-run завершён |
| 1 | `BAD_ARGS` | Невалидные аргументы CLI |
| 2 | `CONFIG_ERROR` | Ошибка конфигурации .env |
| 3 | `RPC_ERROR` | RPC соединение не удалось |
| 4 | `INSUFFICIENT_FUNDS` | Недостаточно BNB |
| 5 | `QUOTE_ERROR` | Ошибка получения котировки |
| 6 | `SWAP_ERROR` | Транзакция провалилась |
| 7 | `USER_CANCELLED` | Пользователь отменил |
| 8 | `TOKEN_INVALID` | Token контракт невалиден on-chain |
| 9 | `PRICE_DEVIATION` | Цена сдвинулась между котировкой и исполнением |
| 10 | `SCAM_DETECTED` | Обнаружен критический anti-scam риск |

## Ссылки на транзакции

После успешного свопа бот выводит:
```
TX Hash: 0x...
BscScan: https://bscscan.com/tx/0x...
Route: PancakeSwap_V2 (60%) + DODO (40%)
```

При провале свопа:
```
TX (failed): https://bscscan.com/tx/0x...
```

## Тестирование

```bash
# Все тесты
npm test

# Конкретный suite
npx jest tests/swap.test.js

# С coverage
npx jest --coverage
```

### Структура тестов

| Suite | Что покрывает |
|---|---|
| `config.test.js` | bnbToWei, loadConfig, валидация конфига (включая ROUTER_ZERO_X_API_KEY), slippageBps, safe serialization |
| `validate.test.js` | Валидация EVM адресов (ethers.isAddress) |
| `retry.test.js` | Exponential backoff, retryable vs non-retryable ошибки |
| `dexscreener.test.js` | Парсинг API ответов, фильтрация по BSC chain |
| `poolSelector.test.js` | Фильтрация пулов, композитный скоринг, ранжирование |
| `onchain.test.js` | ERC20 getTokenInfo, обработка ошибок контракта |
| `fees.test.js` | Gas price fetch, cap при превышении лимита |
| `swap.test.js` | 0x API quote, swap execution, liquidity check, route formatting |
| `antiscam.test.js` | Honeypot simulation (0x /price), proxy detection, ownership check, risk levels |
| `integration.test.js` | CLI parseArgs, EXIT codes |

## Безопасность

- **Никогда** не коммитьте `.env` с приватным ключом или API ключом
- Используйте `PRIVATE_KEY_PATH` с `chmod 600` для лучшей защиты ключа
- Бот предупреждает если `.env` файл читаем другими (Unix)
- Начинайте с малых сумм (`BUY_AMOUNT_BNB=0.001`) и `--dry-run`
- На mainnet (chainId 56) бот предупреждает о реальных средствах
- `MAX_BUY_BNB` ограничивает максимальную сумму (по умолчанию 1 BNB)
- `MAX_GAS_PRICE_GWEI` защищает от переплаты за газ
- Anti-scam проверки автоматически блокируют критически рискованные токены
