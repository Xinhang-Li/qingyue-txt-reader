# 更新日志

## 2026-11-02 · 朗读稳定性修复

### 修复：朗读中切换音色/语速后，读完当前段落就停止（队列停摆）

**现象**：朗读过程中更换音色或调整语速，当前段落能读完，之后朗读永远停止，不再往下推进。

**根因**：`restartTtsCurrent()` 原先的实现是 `speechSynthesis.cancel()` 后同一拍立刻 `speak()`。`cancel()` 在 Chrome 中是异步生效的，紧贴其后的 `speak()` 会让新 utterance 被“误伤”，出现两种结局：

1. 新 utterance 被**静默丢弃**——`onend` / `onerror` 回调都不触发。而队列推进完全依赖 `onend` 里的 `idx++ → 读下一段`，回调不来，朗读就永远停住。
2. 新 utterance 收到迟到的 **`interrupted` 错误**（cancel 的余波）。当时 `onerror` 对 `canceled / interrupted` 直接 `return`（该分支本意是处理“用户主动停止”），队列同样停摆。

**修复**（commit `f0b2c51`）：

- `restartTtsCurrent()` 先递增令牌作废旧回调，`cancel()` 后延迟 80ms 再播报；连续拖动语速条时只有最后一次生效（令牌比对）。
- `onerror` 收到 `canceled / interrupted` 且令牌仍有效（非用户主动停止）时，150ms 后自动重读当前段，最多重试 3 次。
- `speakCurrent()` 增加 2.5 秒看门狗：utterance 被静默丢弃（无任何回调）时自动重读。

### 同轮审查修复的其他隐患

- **Chrome 长句假死**：桌面版 Chrome 播放长 utterance 约 15 秒后会无声假死（`speaking` 仍为 `true`，看门狗检测不到）。修复：朗读期间每 8 秒执行一次 `speechSynthesis.resume()` 唤醒（业界通用 workaround）。
- **旧版 Safari 朗读直接报错**：`chunkForSpeech()` 原先使用正则后行断言 `(?<=…)`，Safari < 16.4 不支持，调用即抛 `SyntaxError`，朗读功能整体不可用。修复：改为逐字符按标点切分，不再依赖 lookbehind。
- **暂停中换音色/语速不生效**：`restartTtsCurrent()` 在暂停状态下直接返回，恢复朗读后仍用旧设置读完当前段。修复：暂停中也执行 cancel 并作废旧令牌，恢复时由 `resumeTts()` 的看门狗以新设置重读当前段。

## 2026-11-02 · 新功能

- 朗读中切换音色/语速即时生效，无需先暂停（commit `32d5610`）。
- 划线工具条新增「▶ 朗读」：停止先前朗读，从选中段落处开始读。
