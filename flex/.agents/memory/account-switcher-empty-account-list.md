---
name: Account switcher invisible after OAuth login
description: Root cause and fix for AccountSwitcher not rendering after successful WS authorize when using the new Deriv trading API (api.derivws.com).
---

## Rule
After a successful WS `authorize()` call, always ensure `resolvedAccountList` is non-empty before calling `setAccountList()`. The new Deriv trading API at `api.derivws.com` can return `authorize.account_list = []` even when auth succeeds.

## Why
`useActiveAccount` finds the active account by:
```js
accountList?.find(account => account.loginid === activeLoginid)
```
If `accountList` is empty, this returns `undefined` → `AccountSwitcher` guard `return (activeAccount && ...)` short-circuits to `false` → switcher invisible. Header shows Deposit button (activeLoginid truthy) but no account selector.

## How to apply
In `api-base.ts` `authorizeAndSubscribe()` success path, after getting the WS response:
1. If `authorize.account_list.length > 0` — use it directly (normal case).
2. If empty — reconstruct from `localStorage.clientAccounts` (written by callback-page.tsx).
3. Still empty — build minimal single entry from `authorize.loginid/currency/is_virtual`.
Pass `resolvedAccountList` (not the raw WS list) to both `setAccountList()` and `setAuthData()`.

The same new-API field-name mismatch already existed for `active_symbols` (normalized in `getActiveSymbols`); `account_list` is another instance of the same pattern.
