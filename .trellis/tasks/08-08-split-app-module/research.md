# 拆分 app.js 的测量记录与踩坑

## 一、决定性事实：文件没有包装闭包

`js/app.js` 以 `import` 开头、以函数定义结尾。用 acorn 实测顶层结构：
528 个真正的顶层节点（336 个函数、143 个变量声明、5 个类），**无包装闭包**。
8 空格缩进只是从 `index.html` 内联脚本搬出时的历史痕迹。

这意味着那 94 个模块级变量是真正的模块顶层变量，可以 `export`。

## 二、活绑定机制已验证可行

用一次性探针验证 ES 模块活绑定：owner 改值 consumer 立刻可见，consumer 通过
setter 改值 owner 也立刻可见，**无副本、无过期值**。这是拆分有状态代码的机制基础。

但目前四步都还没用到它——前三步是零状态块，第四步用的是构造注入 + getter。

## 三、状态耦合的真实分布

94 个模块级可变变量中：

- 85 个有多个写入点（`currentIndex` 19 处、`playlist` 9 处、`playMode` 5 处）
- 只有 9 个是单写入点
- 但**只有约 12 个真正跨块共享**，其余约 70 个是块私有的，应随代码一起搬走

结论：状态留在 `app.js` 当中枢，功能块通过注入访问。想把状态也搬走会立刻造成两份数据。

## 四、块规模分布（用 acorn 精确测量）

最大 25 个顶层声明只占 3200 行（35%），其中 `MobileUIManager` 691 行是唯一大块，
第二名 `bindUserPlaylistUI` 只有 210 行。**长尾才是主体**。

所以达到 2000 行必须按主题成批搬移，不能逐个挑大块。

## 五、`dom` 对象的隐患

`dom` 在 `DOMContentLoaded` 时由 `document.querySelectorAll('[id]')` 收割，
约 224 个键全部由 HTML 决定，JS 里没有任何声明。传 `dom` 给模块等于让它隐式
依赖整个 HTML 结构，契约不可审计。

好消息：`MobileUIManager` 的 91 处 `this.dom` 是**自建缓存**，裸 `dom.` 引用为 0。
所以它不受这个隐患影响。

## 六、这一步踩的四个坑

1. **正则改写漏掉回调形式**。`cyclePlayMode` 作为 `addEventListener` 的回调传递，
   不是调用形式，正则没匹配到。
2. **手写的依赖清单不可靠**。我先列出 11 个依赖，用 acorn 做真正的作用域分析后
   发现是 **17 个**，漏掉了 `escapeHtml`（6 处）、`togglePlayPause`、`playNextSong`
   等。这些会在用户点击时才 `ReferenceError`。
3. **嵌套 `function` 声明丢 `this`**。`mCreateItem`/`mRender` 是 `function` 声明，
   内部 `this` 是 `undefined`，所以所有 `this.deps` 读取抛错。移动端回归立刻报出
   `Cannot read properties of undefined (reading 'deps')`，5 个用例失败。
   改成箭头函数解决，并加契约防止回退。
4. **Tailwind 类名被清除**。新模块含 19 处 Tailwind 类属性但没加进
   `tailwind.config.cjs` 的 `content`，导致类被 purge。门禁的 CSS 层抓住了。
   已改为自动检测：凡发出 Tailwind 工具类的模块都必须在扫描列表里。

第 2、3 点都是「看似完成实则漏改」，只有工具和回归测试能发现，靠读代码发现不了。

## 七、发现并单独修复的既存 bug

`loadPlaylistById`（`app.js:7899`）清空队列后没有同步 `window.playlist`，
而另两处清空点都有。歌单加载失败时会留下过期的已发布队列。

已写复现用例（驱动真实的设置界面歌单 ID 输入框）、修复、变异验证，并加契约
要求每处清空点都在几行内同步。独立提交 `04cae18`。

## 七点五、第 5、6 步的教训

### 用主题分组代替逐个挑大块

最大 25 个顶层声明只占 35%，长尾才是主体。改为按命名前缀把 528 个声明分到 14 个
主题，再看每个主题内部有多少「大间隔」。零间隔=完全连续=可整块搬移。

实测四个零间隔主题：`search` 399 行、`virtual-scroll` 187 行、`welcome` 87 行、
`sleep-timer` 77 行。第 5、6 步就是搬走前两个。

### getter 不能作为赋值目标

第 6 步我把 `currentIndex` 全部替换成 `deps.getCurrentIndex()`，结果产生了
`deps.getCurrentIndex() = actualIndex;` —— 语法非法。

根因：我测量依赖时只看了「读」，漏了「写」。这个块有 2 处写入 `currentIndex`。
修法是额外注入 setter。已加契约禁止 `deps.getXxx() = ...` 形式。

注意 `node --check` **没有**抓到这个错误，因为它按脚本解析；acorn 按模块解析才报出
`Assigning to rvalue`。所以模块语法检查不能只靠 `node --check`。

### 契约可能完全缺失

第 6 步搬完后契约全部通过 —— 但这是坏消息：说明虚拟滚动和 `window.playSongAtIndex`
这类核心代码原本零静态守护。已补 13 条契约，含 6 个私有变量必须留在模块内、
`playSongAtIndex` 必须由新模块发布。

## 八、保留的既存缺陷（未修）

`mobile-ui.js` 里移动端进度条点击调用 `updateProgress()`，但 `app.js` 从未定义
这个顶层函数——原代码就会抛 `ReferenceError`。

拆分必须保持行为不变，所以我保留了同样的失败位置（注入 `undefined`），并在代码
和这里都注明。修它属于单独一次改动。
