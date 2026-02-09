# BSC Token Buyer CLI Bot

CLI-бот для покупки токенов на BSC (BNB Smart Chain) через PancakeSwap V2 Router. Включает on-chain валидацию ERC20 токенов, anti-scam проверки (honeypot, proxy, ownership), анализ пулов через DexScreener и механизмы безопасности транзакций.

## Установка

```bash
npm install
cp .env.example .env
# Заполните .env — RPC URL и приватный ключ
```

### Переменные окружения

| Переменная | Обязательная | По умолчанию | Описание |
|---|---|---|---|
| `RPC_URL` | Да | — | BSC RPC endpoint (например `https://bsc-dataseed.binance.org/`) |
| `PRIVATE_KEY` | Да* | — | Hex-строка (с или без `0x` префикса) |
| `PRIVATE_KEY_PATH` | Да* | — | Путь к файлу ключа (альтернатива `PRIVATE_KEY`) |
| `BUY_AMOUNT_BNB` | Да | — | Сколько BNB тратить на покупку |
| `SLIPPAGE_PERCENT` | Нет | `5` | Проскальзывание в процентах |
| `GAS_LIMIT` | Нет | `300000` | Gas limit для swap транзакции |
| `MAX_GAS_PRICE_GWEI` | Нет | `5` | Максимальная цена газа в gwei (safety cap) |
| `BUY_RETRIES` | Нет | `3` | Количество повторов при ошибке транзакции |
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
 7. Anti-Scam Checks      -> Honeypot simulation, proxy detection, ownership check
 8. Confirmation          -> Сводка для пользователя, подтверждение
 9. Execute Swap          -> PancakeSwap V2 Router swap с retry логикой
10. Result                -> TX hash + ссылка на BscScan
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
- **Honeypot simulation**: Запрашивает `getAmountsOut` для пути BNB→Token→BNB. Если обратный swap (sell) не возможен или теряет >50% — критический риск. >20% — высокий риск.
- **EIP-1967 Proxy Detection**: Читает storage slot `0x360894...`. Если установлен — контракт upgradeable, владелец может изменить логику.
- **Ownership Check**: Вызывает `owner()`. Если owner != `address(0)` — ownership не renounced, владелец может иметь привилегии.

**Шаг 9 — Execute Swap**: Вызывает `swapExactETHForTokensSupportingFeeOnTransferTokens` на PancakeSwap V2 Router. Использует `SupportingFeeOnTransfer` вариант для безопасной работы с дефляционными/tax токенами. При ошибке повторяет до `BUY_RETRIES` раз (не повторяет on-chain revert). Deadline: 5 минут.

## Архитектура

```
src/
├── index.js          Главная точка входа, оркестрация потока, CLI парсинг
├── config.js         Загрузка .env, ethers.Wallet, bnbToWei(), BSC константы
├── validate.js       Валидация EVM адресов (ethers.isAddress)
├── http.js           Общий axios instance с keep-alive agents
├── retry.js          Экспоненциальный backoff для transient ошибок
├── logger.js         Цветной вывод в консоль с timestamps
├── dexscreener.js    Клиент DexScreener API (поиск пулов)
├── poolSelector.js   Фильтрация, скоринг и ранжирование BSC пулов
├── onchain.js        On-chain ERC20 чтение (name, symbol, decimals, totalSupply)
├── fees.js           Получение gas price через provider.getFeeData()
├── swap.js           PancakeSwap V2 Router swap с retry логикой
└── antiscam.js       Honeypot simulation, proxy detection, ownership check
```

### Ключевые архитектурные решения

**PancakeSwap V2 Router напрямую.** Бот взаимодействует с Router контрактом (`0x10ED43C718714eb63d5aA57B78B54704E256024E`) через ethers.Contract. Путь свопа: `[WBNB, tokenAddress]`. Без посредников и агрегаторов — прямой on-chain swap.

**`SupportingFeeOnTransferTokens` вариант.** Обычный `swapExactETHForTokens` упадёт на дефляционных токенах (когда фактически полученная сумма меньше ожидаемой из-за tax). Вариант `SupportingFeeOnTransfer` учитывает это.

**Honeypot = roundtrip simulation.** Запрашиваем `getAmountsOut` для buy (BNB→Token) и sell (Token→BNB). Если sell quote не возможен — honeypot. Если round-trip loss экстремальный — скрытый tax.

**EIP-1967 proxy detection.** Читаем storage slot `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`. Если не нулевой — контракт является upgradeable proxy, владелец может изменить логику в любой момент.

**Целочисленная арифметика для BNB -> wei.** `bnbToWei()` использует split строки + padEnd, а не `parseFloat() * 1e18`. Это исключает ошибки округления float.

**Приватный ключ никогда не сериализуется.** `createSafeConfig()` переопределяет `toJSON()` и `util.inspect` чтобы редактировать wallet. Даже если config случайно залогирован, виден только адрес кошелька.

**ethers v6 с нативными BigInt.** Все суммы (wei, gas, amounts) — BigInt. Slippage рассчитывается через bps (basis points) для поддержки дробных процентов.

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
| `config.test.js` | bnbToWei, loadConfig, валидация конфига, safe serialization |
| `validate.test.js` | Валидация EVM адресов (ethers.isAddress) |
| `retry.test.js` | Exponential backoff, retryable vs non-retryable ошибки |
| `dexscreener.test.js` | Парсинг API ответов, фильтрация по BSC chain |
| `poolSelector.test.js` | Фильтрация пулов, композитный скоринг, ранжирование |
| `onchain.test.js` | ERC20 getTokenInfo, обработка ошибок контракта |
| `fees.test.js` | Gas price fetch, cap при превышении лимита |
| `swap.test.js` | PancakeSwap quote, slippage, swap execution, revert handling |
| `antiscam.test.js` | Honeypot simulation, proxy detection, ownership check, risk levels |
| `integration.test.js` | CLI parseArgs, EXIT codes |

## Безопасность

- **Никогда** не коммитьте `.env` с приватным ключом
- Используйте `PRIVATE_KEY_PATH` с `chmod 600` для лучшей защиты ключа
- Бот предупреждает если `.env` файл читаем другими (Unix)
- Начинайте с малых сумм (`BUY_AMOUNT_BNB=0.001`) и `--dry-run`
- На mainnet (chainId 56) бот предупреждает о реальных средствах
- `MAX_BUY_BNB` ограничивает максимальную сумму (по умолчанию 1 BNB)
- `MAX_GAS_PRICE_GWEI` защищает от переплаты за газ
- Anti-scam проверки автоматически блокируют критически рискованные токены
