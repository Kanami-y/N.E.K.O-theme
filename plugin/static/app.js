/**
 * 主题工坊面板脚本（静态面板，无构建步骤、无框架）
 *
 * 与后端通信的方式完全照搬 wechat_integration/static/script.js：
 *   1. GET  /security/csrf-token            → 拿 CSRF token
 *   2. POST /runs {plugin_id, entry_id, args} → 拿 run_id
 *   3. GET  /runs/{run_id}   每 500ms 轮询   → 直到 succeeded
 *   4. GET  /runs/{run_id}/export            → 取真正的返回值
 *
 * 相对路径可用，因为本页面就是从 48916 端口被服务的（面板 iframe 与 /runs 同源）。
 */

/* ============================================================================
 * 1. 变量目录 —— THEME_CONTRACT.md §3 的权威清单
 * ==========================================================================*/

var CATALOG = [
  {
    group: '聊天气泡',
    items: [
      { key: '--nts-user-bubble-bg', label: '用户气泡背景', type: 'color', native: '#44b7fe' },
      { key: '--nts-user-bubble-text', label: '用户气泡文字', type: 'color', native: '#ffffff' },
      { key: '--nts-user-bubble-border', label: '用户气泡描边', type: 'color', native: 'transparent' },
      { key: '--nts-ai-bubble-bg', label: 'AI 气泡背景', type: 'color', native: '#ffffff', darkNative: 'rgba(42,123,196,0.18)' },
      { key: '--nts-ai-bubble-text', label: 'AI 气泡文字', type: 'color', native: '#24445a', darkNative: '#e0e0e0' },
      { key: '--nts-ai-bubble-border', label: 'AI 气泡描边', type: 'color', native: 'transparent' },
      {
        key: '--nts-code-bg', label: '代码块背景', type: 'color',
        native: 'rgba(91, 111, 145, 0.12)', darkNative: 'rgba(100, 120, 160, 0.18)',
        hint: '行内代码与代码块的底色（.message-markdown-inline-code / .message-markdown-pre）；代码块本体原生没有底色，只有行内代码有；留空即保持原生配色'
      },
      {
        key: '--nts-code-text', label: '代码块文字', type: 'color',
        native: '#22324d', darkNative: '#c0cce0',
        hint: '行内代码与代码块的文字色；原生行内代码 #22324d、代码块 #1f2c42（暗色两者都是 #c0cce0）；留空即保持原生配色'
      },
      {
        key: '--nts-image-bg', label: '图片块背景', type: 'color',
        native: 'transparent', darkNative: 'transparent',
        hint: '消息里图片包裹层 .message-block-image 的底色，垫在图片下方；留空即保持原生（透明，只有图片本身透明或加载失败时才看得见）'
      },
      {
        key: '--nts-tool-bubble-bg', label: '工具/系统气泡背景', type: 'color',
        native: 'linear-gradient(180deg, #f8fafc, #edf2f8)', darkNative: 'linear-gradient(180deg, #232330, #1e1e2a)',
        hint: '工具气泡与系统气泡共用的底色（.message-bubble-tool / .message-bubble-system）；原生工具气泡是渐变、系统气泡是半透明灰（亮 rgba(131,148,175,0.14) / 暗 rgba(80,90,110,0.2)），填写后两者会被拉平成同一个纯色；留空即保持原生'
      },
      {
        key: '--nts-tool-bubble-text', label: '工具/系统气泡文字', type: 'color',
        native: '#2b3a50', darkNative: '#b8bcc4',
        hint: '工具气泡与系统气泡的文字色；原生工具 #2b3a50、系统 #607086（暗色 #b8bcc4 / #9aa0ac）；留空即保持原生配色'
      },
      {
        key: '--nts-status-bg', label: '状态块背景', type: 'color',
        native: 'rgba(70, 129, 227, 0.12)', darkNative: 'rgba(68, 130, 230, 0.15)',
        hint: '消息状态块的底色（.message-block-status 的 info / success / warning / error 四种 tone 共用这一个变量）；原生四种 tone 各不相同（亮 success rgba(48,161,100,0.12)、warning rgba(235,168,52,0.16)、error rgba(223,91,91,0.14)），填写后四种 tone 会被拉平成同一个颜色；留空即保持原生'
      },
      {
        key: '--nts-status-text', label: '状态块文字', type: 'color',
        native: '#28589d', darkNative: '#6fa8ff',
        hint: '消息状态块的文字色（四种 tone 共用这一个变量）；原生四种 tone 各不相同（亮 success #236845、warning #9a6008、error #a63a3a；暗色 #5ec790 / #e8b44a / #e07070），填写后四种 tone 会被拉平成同一个颜色；留空即保持原生'
      }
    ]
  },
  {
    group: '聊天窗口',
    items: [
      { key: '--nts-chat-bg', label: '聊天窗口背景', type: 'color', native: 'transparent',
        hint: '紧凑胶囊形态下那条胶囊的底色由它决定（背板不再抢它）。展开后还影响 #react-chat-window-root 与 .chat-window。留空即保持原生' },
      { key: '--nts-chat-panel-bg', label: '聊天背板背景', type: 'color', native: 'transparent',
        hint: '消息列表背后那块底板的颜色：紧凑态涂 .compact-export-history-scroll，展开/全屏态涂 .message-list 与 .chat-body。留空即保持原生（透明）' },
      {
        key: '--nts-chat-bg-image', label: '聊天背景图片', type: 'image', native: 'none',
        hint: '给消息列表那块底板铺一张图片：设置后图片优先于「聊天背板背景」的纯色（纯色仍在图片下方兜底，图片透明处会透出来）。支持 png/jpg/webp/gif，单张上限 4 MB。合法值只有 none 或 url("…/backgrounds/<文件>")。留空即回原生（无图片）'
      },
      {
        key: '--nts-chat-bg-image-brightness', label: '背景图亮度', type: 'number', native: '1',
        hint: '把「聊天背景图片」整体压暗，避免图片跟正文抢视线。取值 0-1：1 = 原图亮度，0.6 = 压暗四成，0 = 全黑。只往下压、不会变亮（实现方式是一层黑色蒙版盖在图片上，正文完全不受影响——不是给容器加 filter，那样会把气泡和文字一起调暗）。只在设了「聊天背景图片」时生效；留空即保持原图'
      },
      {
        key: '--nts-chat-top-fade', label: '顶部渐隐', type: 'number', native: '1',
        hint: '聊天记录最上边那条渐隐，也就是背景图顶部那层「雾」的来源。取值 0-1：1 = 应用原生（顶部 28px 由透明渐入，图片顶部跟着淡出），0 = 渐隐彻底取消、图片顶边清晰，中间值线性过渡。注意关掉后滚到顶部的消息会硬切、不再淡出'
      },
      {
        key: '--nts-chat-panel-radius', label: '聊天背板圆角', type: 'length', native: '0px',
        hint: '消息列表那块底板的圆角，与「聊天背板背景」配套。用的是独立变量——「通用圆角」会连带改圆按钮和输入框，这里只圆背板。留空即保持原生直角'
      },
      { key: '--nts-topbar-bg', label: '顶栏背景', type: 'color', native: 'transparent' },
      { key: '--nts-topbar-text', label: '顶栏文字', type: 'color', native: 'inherit' },
      {
        key: '--nts-chat-blur', label: '毛玻璃模糊', type: 'blur', native: 'blur(18px)',
        hint: 'CSS 消费方是 backdrop-filter，因此必须写成 blur(18px) 形式；只填 18px 后端会自动补成 blur(18px)；单位只接受 px/rem/em/pt（不支持 % / vh / vw）'
      },
      {
        key: '--nts-bubble-veil', label: '聊天背景虚化', type: 'switch', native: '开',
        hint: '气泡上那层「白纱 + 背景模糊」的总开关。关掉后气泡底完全透明、背景模糊归零，聊天背景图与底色会完整透出来（对比度更高，适合铺了背景图之后觉得画面发灰/看不清的情况）；打开则回到 N.E.K.O 原生观感。底层是 0-1 乘子，同时作用于白纱不透明度与模糊半径。'
      },
      {
        key: '--nts-chat-opacity', label: '聊天面不透明度', type: 'number', native: '1',
        hint: '取值 0-1。走桥接写成 --neko-chat-opacity-factor —— N.E.K.O 自带的透明度乘子：它乘的是各聊天表面底色的 alpha（原生写法形如 rgba(255,255,255,calc(.91 * 该系数))），所以是整体缩放聊天面板/窗口的透明度，不改任何单个颜色。留空即保持原生（系数 1 = 100%）。注意此项曾因应用侧加载器没有 number 值类型而静默丢弃、面板却报成功，现已修复'
      }
    ]
  },
  {
    group: '输入区',
    items: [
      { key: '--nts-input-bg', label: '输入区背景', type: 'color', native: 'rgba(40, 40, 40, 0.65)', darkNative: 'rgba(40,40,40,0.65)' },
      { key: '--nts-input-text', label: '输入文字', type: 'color', native: 'inherit', darkNative: '#e0e0e0' },
      { key: '--nts-input-border', label: '输入区描边', type: 'color', native: 'rgba(255, 255, 255, 0.06)', darkNative: 'rgba(255,255,255,0.06)' },
      { key: '--nts-input-placeholder', label: '占位文字', type: 'color', native: '#9aa7b2', darkNative: '#999999' },
      { key: '--nts-button-bg', label: '工具按钮背景', type: 'color', native: 'transparent', darkNative: '#2d2d2d' },
      { key: '--nts-button-text', label: '工具按钮文字', type: 'color', native: 'inherit' },
      { key: '--nts-button-hover-bg', label: '工具按钮悬停', type: 'color', native: '#44b7fe1a', darkNative: '#44b7fe26', hint: '只在鼠标悬停工具按钮时生效（.composer-tool-btn:hover），不影响按钮静止态（那由「工具按钮背景」管）；留空即保持原生悬停色（亮 #44b7fe1a / 暗 #44b7fe26）' },
      { key: '--nts-send-bg', label: '发送按钮背景', type: 'color', native: '#44b7fe', darkNative: '#2a7bc4' },
      { key: '--nts-send-text', label: '发送按钮文字', type: 'color', native: '#ffffff', darkNative: '#ffffff' }
    ]
  },
  {
    group: '面板 / 弹窗 / 菜单',
    items: [
      {
        key: '--nts-panel-bg', label: '面板背景', type: 'color', native: 'transparent',
        hint: '作用于输入区面板（.composer-panel）与悬浮任务面板（#agent-task-hud）；紧凑胶囊态下面板本身被应用压成透明，此时看「聊天背景」'
      },
      {
        key: '--nts-panel-text', label: '面板文字', type: 'color', native: '#333333', darkNative: '#e0e0e0',
        hint: '作用于悬浮任务面板、访问条等面板面的文字；输入框里的文字请用「输入文字」。紧凑胶囊的文字颜色不跟这里走（避免改面板文字时连胶囊文字一起变色）'
      },
      { key: '--nts-panel-border', label: '面板描边', type: 'color', native: 'rgba(0, 0, 0, 0.08)', darkNative: 'rgba(255,255,255,0.1)' },
      { key: '--nts-popover-bg', label: '弹出菜单背景', type: 'color', native: 'transparent' },
      { key: '--nts-popover-text', label: '弹出菜单文字', type: 'color', native: 'inherit' },
      { key: '--nts-popover-border', label: '弹出菜单描边', type: 'color', native: 'transparent' },
      { key: '--nts-modal-bg', label: '弹窗背景', type: 'color', native: '#ffffff', darkNative: '#2d2d2d' },
      { key: '--nts-modal-text', label: '弹窗文字', type: 'color', native: '#24445a', darkNative: '#e0e0e0' },
      {
        key: '--nts-accent-bg', label: '插件页强调底纹', type: 'color',
        native: 'rgba(42, 123, 196, 0.05)', darkNative: 'rgba(58, 159, 216, 0.1)',
        hint: '走桥接：写 #agent-plugin-content / #agent-plugin-views 上的 --neko-popup-accent-bg，即插件面板标签页的悬停底色与选中底色（#agent-content-tabs button:hover / [aria-selected="true"]）；留空即保持原生（面板自身兜底亮 rgba(42,123,196,.08) / 选中 .10，模式变量亮 rgba(42,123,196,0.05) / 暗 rgba(58,159,216,0.1)）'
      },
      {
        key: '--nts-panel-text-sub', label: '面板次级文字', type: 'color',
        native: '#666666', darkNative: '#b0b0b0',
        hint: '走桥接：写 #agent-plugin-content / #agent-plugin-views 上的 --neko-popup-text-sub，消费方是插件面板顶部的标签页文字与关闭按钮（#agent-content-tabs button / #agent-plugin-close）；留空即保持原生（面板自身还有一层兜底 #667582，亮 #666666 / 暗 #b0b0b0）'
      },
      {
        key: '--nts-overlay-bg', label: '弹窗遮罩背景', type: 'color',
        native: 'transparent', darkNative: 'rgba(0, 0, 0, 0.65)',
        hint: '弹窗背后的整屏遮罩 .modal-overlay 底色；原生亮色模式基本不铺遮罩（常见组件给的 rgba(0,0,0,0.5) 只在个别弹窗生效），暗色是 rgba(0,0,0,0.65)；小剧场/串门这两类透明窗弹窗自带 transparent !important，不受此项影响；留空即保持原生'
      }
    ]
  },
  {
    group: '推荐 / 系统 chip',
    items: [
      { key: '--nts-rec-bg', label: '推荐条背景', type: 'color', native: 'transparent' },
      { key: '--nts-rec-text', label: '推荐条文字', type: 'color', native: 'inherit' },
      { key: '--nts-rec-border', label: '推荐条描边', type: 'color', native: 'rgba(108, 151, 174, 0.18)', darkNative: 'rgb(65, 84, 95)', hint: '只在 .proactive-recommendation-card 上生效；留空即保持原生描边（亮 rgba(108,151,174,0.18) / 暗 rgb(65,84,95)）' },
      { key: '--nts-chip-bg', label: 'chip 背景', type: 'color', native: 'transparent' },
      { key: '--nts-chip-text', label: 'chip 文字', type: 'color', native: 'inherit' }
    ]
  },
  {
    group: '全局',
    items: [
      { key: '--nts-accent', label: '主色调', type: 'color', native: '#2a7bc4' },
      { key: '--nts-link', label: '链接色', type: 'color', native: '#2a7bc4' },
      { key: '--nts-highlight', label: '选中高亮', type: 'color', native: 'rgba(68, 183, 254, 0.35)', darkNative: 'rgba(74,163,223,0.4)' },
      { key: '--nts-scrollbar-thumb', label: '滚动条滑块', type: 'color', native: 'rgba(0, 0, 0, 0.25)', darkNative: 'rgba(255,255,255,0.2)' },
      { key: '--nts-scrollbar-track', label: '滚动条轨道', type: 'color', native: 'transparent' }
    ]
  },
  {
    group: '非颜色项',
    items: [
      {
        key: '--nts-radius', label: '通用圆角（按钮/输入面板）', type: 'length', native: '8px',
        hint: '原生值各组件不同（顶栏 0 / 卡片 12px / 按钮 10px），留空即完全保持原生'
      },
      {
        key: '--nts-bubble-radius', label: '聊天气泡圆角', type: 'length', native: '16px',
        hint: '只影响气泡本体；留空即保持原生（用户气泡 16px/8px 不对称圆角）'
      },
      {
        key: '--nts-shell-radius', label: '聊天窗外壳圆角', type: 'length', native: '14px',
        hint: '只影响聊天窗口外壳 #react-chat-window-shell；留空即保持原生'
      },
      {
        key: '--nts-card-radius', label: '插件卡片圆角', type: 'length', native: '0px',
        hint: '只影响 .agent-plugin-view 卡片；留空即保持原生'
      },
      {
        key: '--nts-modal-radius', label: '弹窗圆角', type: 'length', native: '0px',
        hint: '只影响 .modal-dialog 对话框；留空即保持原生'
      },
      {
        key: '--nts-popover-radius', label: '浮层圆角', type: 'length', native: '12px',
        hint: '只影响 .composer-overflow-popover 等弹出层；留空即保持原生'
      },
      {
        key: '--nts-rec-radius', label: '推荐卡圆角', type: 'length', native: '18px',
        hint: '只影响推荐类气泡卡片；留空即保持原生'
      },
      { key: '--nts-font-family', label: '字体族', type: 'font', native: 'inherit' },
      {
        key: '--nts-font-size', label: '基础字号', type: 'length', native: '0.94rem',
        hint: '消息正文的字号，纯文本与 Markdown 两种消息都会跟着变（如 1rem / 17px）；留空即保持原生'
      },
      {
        key: '--nts-shadow', label: '阴影', type: 'shadow', native: '',
        hint: '如 0 2px 4px rgba(0,0,0,0.1)；作用在 7 个卡片面上（用户/AI 气泡、输入面板、两个浮层、弹窗、推荐卡），会整体替换这些面原有的阴影；留空即保持原生阴影'
      }
    ]
  },
  {
    group: '面板光效 / 玻璃拟态',
    items: [
      {
        key: '--nts-panel-glow-color', label: '光晕颜色', type: 'color', native: '#ffffff',
        hint: '外发光、四角高光、边缘内侧渐变三者共用的颜色。任意 CSS 颜色都行（#7ff / dodgerblue / rgb(120,200,255)）。改这里，三处会一起变色'
      },
      {
        key: '--nts-panel-glow-strength', label: '发光强度', type: 'number', native: '1',
        hint: '0-1 乘子，同时缩放外发光的扩散范围、模糊半径与颜色浓度。0 = 完全无光，1 = 用满「光晕尺寸」。留空即保持原生（无光）'
      },
      {
        key: '--nts-panel-glow-size', label: '光晕尺寸', type: 'length', native: '24px',
        hint: '外发光的基础半径（扩散 1 倍、模糊 0.42 倍）。内侧边缘渐变的宽度也按它算。24px 是柔和的起步值，压到 40px 以上会明显晕开'
      },
      {
        key: '--nts-panel-glow-pulse', label: '呼吸幅度', type: 'number', native: '0',
        hint: '发光强度的呼吸幅度，0-1：0 = 恒定不呼吸，0.5 = 亮度在 100%~50% 之间起伏，1 = 完全暗到亮。留空或 0 都不会挂动画（省一层合成）'
      },
      {
        key: '--nts-panel-glow-speed', label: '呼吸节奏', type: 'time', native: '3.2s',
        hint: '一次呼吸的时长，写 3.2s / 800ms 都行；只填数字按秒算（3 会补成 3s）。上限 60s。数越小越急，5s 以上是慢速呼吸。只在「呼吸幅度」大于 0 时才有意义'
      },
      {
        key: '--nts-panel-border-color', label: '描边颜色', type: 'color', native: 'rgba(255,255,255,.55)',
        hint: '面板边缘那圈半透明描边。想做出玻璃高光感，用白色系带透明度（rgba(255,255,255,.55)）；想做出彩色霓虹边，填高饱和色'
      },
      {
        key: '--nts-panel-border-width', label: '描边粗细', type: 'length', native: '1.5px',
        hint: '边缘描边的宽度。1px 是细高光，2-3px 以上会有明显「玻璃边框」感；留空即不画描边'
      },
      {
        key: '--nts-panel-corner-glow', label: '四角高光', type: 'number', native: '1',
        hint: '0-1 乘子，控制四个角上那四团径向高光的浓度。玻璃拟态里最容易出「立体感」的一项；0 = 关闭，1 = 最亮'
      },
      {
        key: '--nts-panel-edge-gradient', label: '边缘内侧渐变', type: 'number', native: '1',
        hint: '0-1 乘子，控制从边缘往内柔和衰减的那层亮光（inset 阴影），配合外发光能做出「面板自己在发亮」的效果。0 = 关闭'
      },
      {
        key: '--nts-panel-sheen', label: '玻璃反射高光', type: 'number', native: '1',
        hint: '0-1 乘子，控制从左上斜下来那条高光带（模拟玻璃反光）。0.3-0.5 比较自然，1 会明显发白'
      },
      {
        key: '--nts-panel-inner-glow', label: '内阴影', type: 'number', native: '1',
        hint: '0-1 乘子，控制面板内侧一圈淡淡的下沉阴影，让面板看起来「厚」。0 = 关闭'
      },
      {
        key: '--nts-panel-glass-tint', label: '玻璃底色', type: 'color', native: 'transparent',
        hint: '半透明玻璃底色，铺在「聊天背板背景」之上、背景图之下。想做出磨砂玻璃，填 rgba(255,255,255,.14) 这类带透明度的亮色（暗色主题用 rgba(20,30,45,.35)）'
      },
      {
        key: '--nts-panel-glass-blur', label: '玻璃磨砂', type: 'blur', native: 'blur(18px)',
        hint: '把「聊天背景图片」本身糊掉（只糊图片，正文不受影响 —— 走的是夹在图片与文字之间的负层）。写 blur(18px) 或只写 18px（后端自动补成 blur(18px)）；单位只接受 px/rem/em/pt'
      }
    ]
  }
];

var CATALOG_BY_KEY = {};
CATALOG.forEach(function (group) {
  group.items.forEach(function (item) { CATALOG_BY_KEY[item.key] = item; });
});

/** 行首的类型标签：告诉用户这一行接受什么形态的值。 */
var TYPE_LABEL = {
  color: '色',
  length: '尺寸',
  blur: '模糊',
  number: '数值',
  font: '字体',
  shadow: '阴影',
  image: '图片',
  switch: '开关',
  time: '节奏'
};

/* ============================================================================
 * 2. 客户端校验镜像（与后端 __init__.py 的规则保持一致，仅用于即时反馈；
 *    真正的安全边界永远是后端）
 * ==========================================================================*/

var RE_HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// CSS 命名颜色（含 currentcolor）。刻意不收 inherit/initial/unset/revert：
// 它们把颜色继承成父级，会让「只改气泡文字色」串到别处去。
var COLOR_NAMES = ('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue' +
  'blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson' +
  'currentcolor cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta' +
  'darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise' +
  'darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia' +
  'gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink' +
  'indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral' +
  'lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray' +
  'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue' +
  'mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose' +
  'moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod' +
  'palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple' +
  'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna' +
  'silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal' +
  'thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' ');
var NAMED_COLOR = Object.create(null);
(function () {
  for (var i = 0; i < COLOR_NAMES.length; i += 1) { NAMED_COLOR[COLOR_NAMES[i]] = 1; }
}());
function isNamedColor(t) { return NAMED_COLOR[String(t).toLowerCase()] === 1; }
var RE_RGB = /^rgba?\(\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*(,\s*(0|1|0?\.[0-9]+)\s*)?\)$/i;
var RE_HSL = /^hsla?\(\s*-?[0-9]{1,3}(\.[0-9]+)?\s*,\s*[0-9]{1,3}(\.[0-9]+)?%\s*,\s*[0-9]{1,3}(\.[0-9]+)?%\s*(,\s*(0|1|0?\.[0-9]+)\s*)?\)$/i;
var RE_LENGTH = /^-?[0-9]{1,4}(\.[0-9]+)?(px|rem|em|%|pt|vh|vw)$/i;
var RE_PERCENT = /^[0-9]{1,3}(\.[0-9]+)?%$/;
var RE_BLUR = /^blur\(\s*-?[0-9]{1,4}(\.[0-9]+)?(px|rem|em|pt)\s*\)$/i;
/* 模糊允许裸长度（后端会把 18px 补成 blur(18px)），但单位只认 px/rem/em/pt：
 * % / vh / vw 会被后端归一成 blur(18%) 这样的非法 CSS，loader 静默丢弃。 */
var RE_BLUR_LENGTH = /^-?[0-9]{1,4}(\.[0-9]+)?(px|rem|em|pt)$/i;
// 允许 1.0 / 1.00（用户最自然地把「100%」写成 1.0）；仍拒绝 1.5 / 2。
var RE_NUMBER = /^(?:0|1|0?\.[0-9]+|1\.0+)$/;
var RE_ZERO = /^0$/;
/* 时长（animation-duration）：带单位 s/ms，或裸数字按秒。与后端 RE_TIME /
 * loader RE_TIME 三处保持一致；上限 60s（超过 1 分钟对观感没有意义，还能挡住
 * 打字打错量级，例如 3000 当成秒 = 50 分钟）。 */
var RE_TIME = /^(?:(?:0|[1-9][0-9]{0,3})(?:\.[0-9]{1,3})?(?:s|ms))$/i;
var RE_TIME_BARE = /^(?:0|[1-9][0-9]{0,3})(?:\.[0-9]{1,3})?$/;
var TIME_MAX_SECONDS = 60;
var RE_FONT = /^[A-Za-z0-9\u4e00-\u9fff ,'"\-_.]{1,200}$/;
var RE_FORBIDDEN = /[;{}<>\\]|@import|url\s*\(/i;
var RE_INSET = /^inset$/i;
/* 聊天背景图：整串锚定成「none」或插件 backgrounds/ 下图片的绝对 url(...)。
 * 只认 127.0.0.1 / localhost —— 背景图由插件服务在 48916 提供，而消费方是
 * 应用窗口（48911），相对路径会被解析到应用自己的静态目录（404）。
 * 与后端 RE_BG_URL、loader RE_BG_VALUE 三处必须一致。 */
var RE_BG_VALUE = /^(?:none|url\(\s*"?(?:https?:\/\/(?:127\.0\.0\.1|localhost):[0-9]{2,5})?\/plugin\/neko_theme_studio\/ui\/backgrounds\/[A-Za-z0-9._-]{1,80}"?\s*\))$/i;

/** 与后端 _shadow_tokens 同构：按「括号外空白」切分；括号不配对 → []。 */
function shadowTokens(value) {
  var tokens = [], depth = 0, buf = '';
  for (var i = 0; i < value.length; i += 1) {
    var ch = value[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth < 0) return []; }
    if (/\s/.test(ch) && depth === 0) {
      if (buf) { tokens.push(buf); buf = ''; }
      continue;
    }
    buf += ch;
  }
  if (buf) tokens.push(buf);
  if (depth !== 0) return [];
  return tokens;
}

/**
 * box-shadow 的结构校验。只做「token 白名单」是不够的：浏览器对 box-shadow 的
 * 语法要求是 <inset>? && <length>{2,4} && <color>?，而百分比在 box-shadow 里
 * 不是合法长度。旧实现放行 '0 0 10% #000' / '1px' / '1px 2px 3px 4px 5px'，
 * 面板显示已应用，浏览器却把整条声明丢掉 —— 与「改了设置但外观不变」完全一样。
 * 三处校验（面板 / loader / 后端）必须给出同一判定，见 THEME_CONTRACT §9.10b。
 */
/** 按「顶层逗号」切多层 box-shadow（后端 _split_shadow_layers 同构）。 */
function shadowLayers(value) {
  var layers = [];
  var depth = 0;
  var buf = '';
  for (var i = 0; i < value.length; i += 1) {
    var ch = value.charAt(i);
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth < 0) return []; }
    if (ch === ',' && depth === 0) {
      if (buf.replace(/\s+/g, '')) layers.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (depth !== 0) return [];
  if (buf.replace(/\s+/g, '')) layers.push(buf.trim());
  return layers;
}

/** 单层 box-shadow 的 token 校验（与后端 _shadow_layer_ok 同判定）。 */
function shadowLayerOk(tokens) {
  if (!tokens.length || tokens.length > 6) return false; // inset + 4 长度 + 颜色
  var lengths = 0;
  var colors = 0;
  var insets = 0;
  for (var i = 0; i < tokens.length; i += 1) {
    var t = tokens[i];
    if (RE_INSET.test(t)) {
      if (++insets > 1) return false;
      continue;
    }
    if (isNamedColor(t) || RE_HEX.test(t) || RE_RGB.test(t) || RE_HSL.test(t)) {
      if (++colors > 1) return false;
      continue;
    }
    // 百分比不是 box-shadow 的合法长度（50% 会被浏览器整条丢弃）
    if (RE_PERCENT.test(t) || t.indexOf('%') !== -1) return false;
    if (RE_LENGTH.test(t) || RE_ZERO.test(t)) {
      lengths += 1;
      if (lengths > 4) return false;
      // 负值只有前两个长度（x/y 偏移）合法；模糊半径与扩散半径不能为负
      if (t.charAt(0) === '-' && lengths > 2) return false;
      continue;
    }
    return false;
  }
  return lengths >= 2;
}

/** 支持逗号分隔的多层阴影（霓虹发光主题的标准写法）。 */
function isSafeShadow(value) {
  var layers = shadowLayers(value);
  if (!layers.length || layers.length > 4) return false;
  for (var i = 0; i < layers.length; i += 1) {
    if (!shadowLayerOk(shadowTokens(layers[i]))) return false;
  }
  return true;
}

/** 与后端 __init__.py 的 _is_safe_value 逐条对齐；仅作即时反馈，安全边界在后端。 */
function isSafeValue(key, value) {
  if (typeof value !== 'string') return false;
  var v = value.trim();
  if (!v || v.length > 300) return false;
  var item = CATALOG_BY_KEY[key];
  var type = item ? item.type : 'color';
  // 背景图必须排在 RE_FORBIDDEN 之前：黑名单里有 `url\s*\(`，而 url(...) 正是
  // 背景图的唯一合法写法。整串锚定，只认 none 或本插件 backgrounds/ 的绝对地址。
  if (type === 'image') return RE_BG_VALUE.test(v);
  if (RE_FORBIDDEN.test(v)) return false;
  if (type === 'color') {
    return RE_HEX.test(v) || RE_RGB.test(v) || RE_HSL.test(v) || isNamedColor(v);
  }
  // 负长度/负半径在 CSS 里一律非法（整条声明被丢弃 → 面板报成功、外观不变），
  // 后端 _is_safe_value 对 length/blur 单独拦 "-"；这里镜像同一条规则。
  // （shadow 的偏移量要负号，走的是 isSafeShadow 的 token 分支，不受影响。）
  if (type === 'length') {
    if (v.indexOf('-') !== -1) return false;
    return RE_LENGTH.test(v) || RE_PERCENT.test(v) || RE_ZERO.test(v);
  }
  if (type === 'blur') {
    if (v.indexOf('-') !== -1) return false;
    // 只接受 px/rem/em/pt（可写 blur(18px) 或裸 18px，后端会把裸长度补成 blur()）。
    // 旧实现直接用 RE_LENGTH（含 % / vh / vw）：18% 能通过面板校验，后端归一成
    // blur(18%) 非法 CSS 被 loader 丢弃 —— 「应用成功但外观不变」的根因之一。
    return RE_BLUR.test(v) || RE_BLUR_LENGTH.test(v) || RE_ZERO.test(v);
  }
  if (type === 'number') {
    // 百分比只接受 0–100（--nts-chat-opacity 是 0–1 乘子，999% 这类写法对应用无意义，后端会静默丢弃）
    if (RE_PERCENT.test(v)) return parseFloat(v) <= 100;
    return RE_NUMBER.test(v);
  }
  if (type === 'time') {
    // 裸数字按秒（后端会补 s）；带单位只认 s/ms，且换算后不得超过 60s。
    if (RE_TIME_BARE.test(v)) return parseFloat(v) <= TIME_MAX_SECONDS;
    if (!RE_TIME.test(v)) return false;
    var secs = /ms$/i.test(v) ? parseFloat(v) / 1000 : parseFloat(v);
    return isFinite(secs) && secs >= 0 && secs <= TIME_MAX_SECONDS;
  }
  if (type === 'font') return RE_FONT.test(v);
  if (type === 'shadow') return isSafeShadow(v);
  return false;
}

/* ============================================================================
 * 3. 颜色工具
 * ==========================================================================*/

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  s = clamp(s, 0, 100) / 100;
  l = clamp(l, 0, 100) / 100;
  if (s === 0) { var g = Math.round(l * 255); return [g, g, g]; }
  var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  var p = 2 * l - q;
  function hue(t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }
  return [
    Math.round(hue(h + 1 / 3) * 255),
    Math.round(hue(h) * 255),
    Math.round(hue(h - 1 / 3) * 255)
  ];
}

/** 解析一个 CSS 颜色 → {r,g,b,a}；无法解析返回 null。 */
function parseColor(input) {
  if (typeof input !== 'string') return null;
  var v = input.trim();
  if (!v) return null;
  if (v.toLowerCase() === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  var m = v.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    var h = m[1];
    if (h.length === 3) {
      return {
        r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16), a: 1
      };
    }
    if (h.length === 4) {
      // #RGBA：每个 nibble 复制成双位，alpha = 末位 / 15（等价 0x尾尾 / 255）
      return {
        r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16),
        a: parseInt(h[3] + h[3], 16) / 255
      };
    }
    if (h.length === 6) {
      return {
        r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1
      };
    }
    if (h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
        a: parseInt(h.slice(6, 8), 16) / 255
      };
    }
    return null;
  }

  m = v.match(/^rgba?\(([^)]*)\)$/i);
  if (m) {
    var parts = m[1].split(',').map(function (s) { return s.trim(); });
    if (parts.length < 3) return null;
    var r = parseInt(parts[0], 10), g = parseInt(parts[1], 10), b = parseInt(parts[2], 10);
    var a = parts.length > 3 ? parseFloat(parts[3]) : 1;
    if ([r, g, b].some(function (n) { return !isFinite(n); })) return null;
    return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: isFinite(a) ? clamp(a, 0, 1) : 1 };
  }

  m = v.match(/^hsla?\(([^)]*)\)$/i);
  if (m) {
    var hp = m[1].split(',').map(function (s) { return s.trim(); });
    if (hp.length < 3) return null;
    var rgb = hslToRgb(parseFloat(hp[0]), parseFloat(hp[1]), parseFloat(hp[2]));
    var al = hp.length > 3 ? parseFloat(hp[3]) : 1;
    return { r: rgb[0], g: rgb[1], b: rgb[2], a: isFinite(al) ? clamp(al, 0, 1) : 1 };
  }

  return null;
}

function toHex(r, g, b) {
  function h(n) { var s = clamp(Math.round(n), 0, 255).toString(16); return s.length === 1 ? '0' + s : s; }
  return '#' + h(r) + h(g) + h(b);
}

function toRgba(r, g, b, a) {
  var alpha = Math.round(clamp(a, 0, 1) * 100) / 100;
  return 'rgba(' + clamp(Math.round(r), 0, 255) + ',' + clamp(Math.round(g), 0, 255) + ',' + clamp(Math.round(b), 0, 255) + ',' + alpha + ')';
}

/* ============================================================================
 * 4. 插件调用（照搬 wechat_integration/static/script.js 的约定）
 * ==========================================================================*/

var PLUGIN_ID = 'neko_theme_studio';
var RUNS_URL = '/runs';
/* 与 plugin/__init__.py 的 DEFAULT_THEME_NAME、index.html 主题名 placeholder 三处一致。
 * v0.1.4 起后端把空串/纯空白 name 视为「恢复默认名」并返回默认名，不再报错；
 * 面板仍显式提交这个默认名，语义相同且不依赖后端实现。 */
var DEFAULT_THEME_NAME = '默认';
var POLL_DELAY_MS = 500;
var CSRF_BOOTSTRAP_TIMEOUT_MS = 5000;
var CSRF_BOOTSTRAP_RETRY_TIMEOUT_MS = 30000;
var CALL_DEADLINE_MS = 25000;
/* 单次请求超时。旧实现只有 CSRF 引导步有 AbortController，POST / 轮询 / 导出
 * 都没有超时：插件服务半死时请求永远不返回，面板一直转圈、按钮永久禁用。 */
var POST_TIMEOUT_MS = 30000;
var POLL_TIMEOUT_MS = 5000;
var EXPORT_TIMEOUT_MS = 15000;
/* 轮询连续失败多少次就放弃。旧实现把 4xx/5xx 当暂时错误重试到 25s 超时，
 * 再命中 looksLikePluginDown 触发自愈重试，最坏 ~51s 锁死。 */
var POLL_MAX_FAILURES = 3;

var csrfTokenPromise = null;

function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

/**
 * 带超时的 fetch。超时抛出的错误带 timeout=true，供上层区分「超时」与「HTTP 失败」。
 * 手写 AbortController 而不是 AbortSignal.timeout：后者在旧版 Electron/Chrome 里
 * 不一定存在，而这个静态面板没有构建步骤、无法做 polyfill。
 */
function fetchWithTimeout(url, options, timeoutMs) {
  var opts = options || {};
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  opts.signal = controller.signal;
  return fetch(url, opts).catch(function (error) {
    if (error && error.name === 'AbortError') {
      var timeoutError = new Error('请求超时（' + Math.round(timeoutMs / 1000) + 's）');
      timeoutError.timeout = true;
      throw timeoutError;
    }
    throw error;
  }).finally(function () { clearTimeout(timer); });
}

async function mutationHeaders(timeoutMs) {
  if (!csrfTokenPromise) {
    var bootstrapAbort = new AbortController();
    var bootstrapTimer = setTimeout(function () { bootstrapAbort.abort(); }, timeoutMs);
    csrfTokenPromise = fetch('/security/csrf-token', { credentials: 'same-origin', signal: bootstrapAbort.signal })
      .then(function (response) {
        if (!response.ok) throw new Error('CSRF token bootstrap failed: HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        if (!data || typeof data.csrf_token !== 'string' || !data.csrf_token) {
          throw new Error('CSRF token bootstrap returned an invalid token');
        }
        return data.csrf_token;
      })
      .finally(function () { clearTimeout(bootstrapTimer); });
  }
  var pending = csrfTokenPromise;
  var waitTimer;
  try {
    var token = await Promise.race([
      pending,
      new Promise(function (resolve) { waitTimer = setTimeout(function () { resolve(null); }, timeoutMs); })
    ]);
    if (token) return { 'X-CSRF-Token': token };
    console.warn('CSRF token not ready; sending without it');
    return {};
  } catch (error) {
    if (csrfTokenPromise === pending) csrfTokenPromise = null;
    console.warn('CSRF token unavailable; sending without it:', error);
    return {};
  } finally {
    clearTimeout(waitTimer);
  }
}

async function isCsrfTokenFailure(response) {
  if (response.headers.get('X-CSRF-Failure') === 'token') return true;
  try {
    var data = await response.clone().json();
    return Boolean(data && data.detail && data.detail.csrf_failure === 'token');
  } catch (error) {
    return false;
  }
}

async function postWithCsrfRetry(url, body) {
  for (var attempt = 0; ; attempt += 1) {
    var response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        await mutationHeaders(attempt === 0 ? CSRF_BOOTSTRAP_TIMEOUT_MS : CSRF_BOOTSTRAP_RETRY_TIMEOUT_MS)
      ),
      body: body
    }, POST_TIMEOUT_MS);
    if (attempt > 0 || response.status !== 403 || !(await isCsrfTokenFailure(response))) return response;
    csrfTokenPromise = null;
  }
}

/* 宿主的错误包装：entry 里 return Err(SdkError("导入内容为空。")) 时，宿主会把它包成
 *   Plugin 'neko_theme_studio' entry 'entry import_theme' execution failed:
 *   Plugin 'neko_theme_studio' entry 'import_theme' execution failed: 导入内容为空。
 * 有时还会套两层。原样显示给用户就是一句看不懂的内部报错，所以把外壳剥掉，
 * 只留插件自己写的中文原因；剥完仍是空串时退回原文本，绝不吞掉错误。 */
var HOST_ERROR_WRAPPER = /execution failed:\s*/g;

function stripHostErrorWrapper(text) {
  var msg = String(text == null ? '' : text);
  var cut = -1;
  var m;
  HOST_ERROR_WRAPPER.lastIndex = 0;
  while ((m = HOST_ERROR_WRAPPER.exec(msg)) !== null) cut = m.index + m[0].length;
  if (cut > 0) msg = msg.slice(cut);
  return msg.trim() || String(text == null ? '' : text).trim();
}

function pluginErrorMessage(error) {
  if (!error) return '';
  if (typeof error === 'string') return stripHostErrorWrapper(error);
  if (typeof error.message === 'string') return stripHostErrorWrapper(error.message);
  if (typeof error.detail === 'string') return stripHostErrorWrapper(error.detail);
  if (typeof error.code === 'string') return error.code;
  return '';
}

/* 自愈：插件进程没在跑时，面板自己把它拉起来再重试一次。
 * 面板本身就跑在 48916 上（同源），/plugins/refresh 与 /plugin/<id>/start 都是
 * 现成的端点，缺的只是 CSRF 令牌 —— 复用 mutationHeaders 即可。
 * 实测背景：应用冷启动后插件可能停在 stopped（用户插件总开关默认关），
 * 此时面板能打开但每次调用都失败，用户看到的就是「面板改了颜色但窗口不变」。 */
var reviveInFlight = null;

function revivePlugin() {
  if (reviveInFlight) return reviveInFlight;
  reviveInFlight = (async function () {
    // 旧实现只 await 不看 response.ok：403 / 500 也当成功，且错误全被吞掉，
    // 用户最终只看到一句「调用超时」，不知道插件根本没被拉起来。
    state.lastReviveError = '';
    var errors = [];
    try {
      var refreshResp = await postWithCsrfRetry('/plugins/refresh', '{}');
      if (!refreshResp.ok) errors.push('/plugins/refresh 返回 HTTP ' + refreshResp.status);
    } catch (error) {
      errors.push('刷新插件列表失败：' + pluginErrorMessage(error));
    }
    try {
      var startResp = await postWithCsrfRetry('/plugin/' + PLUGIN_ID + '/start', '{}');
      if (!startResp.ok) errors.push('/plugin/' + PLUGIN_ID + '/start 返回 HTTP ' + startResp.status);
    } catch (error) {
      errors.push('启动插件失败：' + pluginErrorMessage(error));
    }
    state.lastReviveError = errors.join('；');
    await delay(900);
  })();
  var done = function () { reviveInFlight = null; };
  reviveInFlight.then(done, done);
  return reviveInFlight;
}

/** 只有「插件没起来」这一类失败才值得自愈，参数错误重试没有意义。 */
function looksLikePluginDown(error) {
  var msg = pluginErrorMessage(error) || '';
  if (/^HTTP 5/.test(msg)) return true;
  if (/^HTTP 404/.test(msg)) return true;
  if (msg.indexOf('超时') !== -1) return true;
  return /not found|not running|no such plugin|插件未运行|未启动/i.test(msg);
}

/** 调用一个插件 entry，失败且像是插件没起来时，自愈一次再重试。
 *
 * 自愈只针对「创建 run」这一步失败（error.phase === 'post'）：轮询/导出失败说明
 * 插件已经接单、只是慢或服务端状态异常，重跑整轮不会更快，只会把 25s 超时
 * 拖成 ~51s（旧实现实测到过的锁死）。超时同样不重试 —— 再等一轮只是更久。 */
async function callPlugin(entryId, args) {
  try {
    return await callPluginOnce(entryId, args);
  } catch (error) {
    if (!error || error.phase !== 'post' || error.timeout || !looksLikePluginDown(error)) throw error;
    await revivePlugin();
    try {
      return await callPluginOnce(entryId, args);
    } catch (retryError) {
      // 自愈失败必须把状态码/原因带到最终错误文案里，否则用户只看到「应用失败」。
      var reason = pluginErrorMessage(retryError) || '调用失败';
      var reviveReason = state.lastReviveError || '原因未知';
      throw new Error(reason + '\n插件未运行，自动启动失败：' + reviveReason);
    }
  }
}
/** 调用一个插件 entry，返回其 JSON 结果（单次，不做自愈）。 */
async function callPluginOnce(entryId, args) {
  var resp;
  try {
    resp = await postWithCsrfRetry(
      RUNS_URL,
      JSON.stringify({ plugin_id: PLUGIN_ID, entry_id: entryId, args: args || {} })
    );
  } catch (error) {
    if (error && !error.phase) error.phase = 'post';
    throw error;
  }
  if (!resp.ok) {
    var httpError = new Error('HTTP ' + resp.status);
    httpError.phase = 'post';
    httpError.status = resp.status;
    throw httpError;
  }
  var ids = await resp.json();
  var runId = ids.run_id || ids.id;
  if (!runId) throw new Error('未获取到 run_id');

  var deadline = Date.now() + CALL_DEADLINE_MS;
  var pollFailures = 0;
  while (Date.now() < deadline) {
    var poll;
    try {
      poll = await fetchWithTimeout(RUNS_URL + '/' + runId, {}, POLL_TIMEOUT_MS);
    } catch (pollError) {
      if (pollError && !pollError.phase) pollError.phase = 'poll';
      throw pollError;
    }
    if (!poll.ok) {
      // 404 = run 记录不存在，继续轮询只是白等；其它非 2xx 连续 N 次也立即失败。
      if (poll.status === 404) {
        var notFoundError = new Error('HTTP 404（run 记录不存在）');
        notFoundError.phase = 'poll';
        notFoundError.status = 404;
        throw notFoundError;
      }
      pollFailures += 1;
      if (pollFailures >= POLL_MAX_FAILURES) {
        var pollHttpError = new Error('HTTP ' + poll.status);
        pollHttpError.phase = 'poll';
        pollHttpError.status = poll.status;
        throw pollHttpError;
      }
      await delay(POLL_DELAY_MS);
      continue;
    }
    pollFailures = 0;
    var rec = await poll.json();
    if (rec.status === 'succeeded') {
      var exp;
      try {
        exp = await fetchWithTimeout(RUNS_URL + '/' + runId + '/export', {}, EXPORT_TIMEOUT_MS);
      } catch (exportError) {
        if (exportError && !exportError.phase) exportError.phase = 'export';
        throw exportError;
      }
      if (!exp.ok) {
        var exportHttpError = new Error('导出结果失败：HTTP ' + exp.status);
        exportHttpError.phase = 'export';
        exportHttpError.status = exp.status;
        throw exportHttpError;
      }
      var payload = await exp.json();
      var items = payload.items || [];
      var item = items.find(function (i) { return i.type === 'json' && i.json; }) || items[0];
      if (!item) throw new Error('导出结果为空（没有 type=json 的条目）');
      var raw = item.json || {};
      // 剥掉 {success, code, data} 包装层。判据必须落在**当前对象自己**身上：
      // 运行结果的外层是 {"success":true,"data":{...调色板...}}，而内层的调色板
      // 自身并没有 success/error 字段。若把判据写成 raw.data.success（即检查内层），
      // 循环永不执行，调用方拿到的是包装层 —— 面板读到的调色板字段全是 undefined，
      // 所有颜色都会被当成未设置（实测到过的真 bug）。
      while (raw && raw.data && typeof raw.data === 'object' && ('success' in raw || 'error' in raw)) {
        raw = raw.data;
      }
      if (raw && raw.error) throw new Error(pluginErrorMessage(raw.error) || '插件调用失败');
      return raw;
    }
    if (['failed', 'canceled', 'timeout'].indexOf(rec.status) !== -1) {
      throw new Error((rec.error && rec.error.message) || rec.message || rec.status);
    }
    await delay(POLL_DELAY_MS);
  }
  var deadlineError = new Error('调用超时');
  deadlineError.phase = 'poll';
  deadlineError.timeout = true;
  throw deadlineError;
}

/* ============================================================================
 * 5. 状态
 * ==========================================================================*/

var state = {
  mode: 'light',            // 'light' | 'dark' —— 编辑 vars 还是 dark_vars
  palette: null,            // 服务器上的调色板（唯一真相）
  edited: { light: {}, dark: {} },  // 用户真正改过的键 → 值
  cleared: { light: {}, dark: {} }, // 用户点了「清空」的键 → true（提交空串 = 删除）
  collapsed: {},
  filter: '',               // 搜索框里的过滤词（小写比较）
  onlyDirty: false,         // 只看改动：隐藏未改动的行
  busy: false,
  modalMode: 'import',
  modalReturnFocus: null,
  // 名称 / 启用的「已保存基线」：由 renderMeta 写入，applyTheme 用它判断有没有改动。
  // 初值等于 index.html 的 DOM 初值，所以首次 get_theme 失败（palette=null）时
  // 只改名称或启用开关也能被识别成有效改动。
  metaName: '',
  metaEnabled: true,
  // 自愈（revivePlugin）失败原因，拼进最终错误提示里。
  lastReviveError: ''
};

function editedMap() { return state.edited[state.mode]; }
function clearedMap() { return state.cleared[state.mode]; }

function isDirty(key) {
  return Object.prototype.hasOwnProperty.call(editedMap(), key) ||
    Object.prototype.hasOwnProperty.call(clearedMap(), key);
}

function dirtyCount() {
  var light = Object.keys(state.edited.light).length + Object.keys(state.cleared.light).length;
  var dark = Object.keys(state.edited.dark).length + Object.keys(state.cleared.dark).length;
  return light + dark;
}

/** 该行在当前模式下「显示」的值：改过就用改的值，否则用原生参考值。 */
function displayValue(key) {
  if (Object.prototype.hasOwnProperty.call(editedMap(), key)) return editedMap()[key];
  if (Object.prototype.hasOwnProperty.call(clearedMap(), key)) return '';
  var server = serverValue(key);
  if (server !== null) return server;
  if (state.mode === 'dark') {
    var item = CATALOG_BY_KEY[key];
    if (item && item.darkNative !== undefined) return item.darkNative;
  }
  return '';
}

/** 服务器调色板里该键的值（当前模式），没有则 null。 */
function serverValue(key) {
  if (!state.palette) return null;
  var bag = state.mode === 'dark' ? state.palette.dark_vars : state.palette.vars;
  if (bag && Object.prototype.hasOwnProperty.call(bag, key)) return bag[key];
  return null;
}

/** 提交时该键的取值：改过 → 值；清空 → ''（删除）；没碰过 → undefined（不发）。 */
function submitValue(key) {
  if (Object.prototype.hasOwnProperty.call(editedMap(), key)) return editedMap()[key];
  if (Object.prototype.hasOwnProperty.call(clearedMap(), key)) return '';
  return undefined;
}

function markEdited(key, value) {
  // 记住「上一个通过校验的编辑值」：非颜色行输入非法时要回滚到它，
  // 否则应用仍会提交上一个合法值并报成功（用户以为新输入生效了）。
  rowValidCache[key] = value;
  delete clearedMap()[key];
  // 改回服务器上已有的值 = 没改：否则把值敲回去后按钮仍显示「已改」，
  // 应用时还会把同值再写一遍（版本号 +1，用户以为哪里坏了）。
  if (serverValue(key) === value) {
    delete editedMap()[key];
    return;
  }
  editedMap()[key] = value;
}

function markCleared(key) {
  delete editedMap()[key];
  delete rowValidCache[key];
  markRowInvalid(key, false);
  clearedMap()[key] = true;
}

/**
 * 「清空」的语义是「删掉 theme.json 里的这一项」。若服务器本来就没有这一项，
 * 清空应当退化成「撤销本地编辑」而不是记一条空串提交（否则干净的行点一下清空
 * 就凭空多出一项改动，应用后版本号变化但外观不变）。
 * @returns {boolean} true = 真的提交了删除
 */
function clearRow(key) {
  var hasServer = serverValue(key) !== null;
  if (!hasServer) {
    delete editedMap()[key];
    delete clearedMap()[key];
    delete rowValidCache[key];
    markRowInvalid(key, false);
    return false;
  }
  markCleared(key);
  return true;
}

/* ---------------- 行级「非法输入」与「颜色记忆」 ----------------
 * 1) invalidRows：哪几行当前是红框非法态。applyTheme 见到非 0 就阻止应用，
 *    避免「输入非法 → 应用仍提交上一个合法值并报成功」。
 * 2) rowValidCache：每行上一次通过校验的编辑值；输入非法时把 edited 回滚到它
 *    （没有就删除该键 = 回退服务器值），使面板状态与将提交的内容一致。
 * 3) lastRgbByKey：全透明行记住最近一次的 RGB，让 alpha 滑块在 transparent
 *    状态下仍然可用（旧实现一置灰，用户就再也拖不回半透明）。 */
var rowValidCache = {};
var invalidRows = {};
var lastRgbByKey = {};

function markRowInvalid(key, bad) {
  if (bad) invalidRows[key] = true;
  else delete invalidRows[key];
}

function invalidRowCount() { return Object.keys(invalidRows).length; }

function invalidInputHint(item) {
  if (item && item.type === 'blur') return '模糊只接受 px/rem/em/pt（可写 18px 或 blur(18px)）';
  return '该值不合法，请改成合法值或点「清空」';
}

/** 非法输入时回滚到上一个合法编辑值；没有就删掉本地编辑（退回服务器值）。 */
function rollbackRowToLastValid(key) {
  if (Object.prototype.hasOwnProperty.call(rowValidCache, key)) {
    markEdited(key, rowValidCache[key]);
  } else {
    delete editedMap()[key];
  }
}

function markAllRowsValid() { invalidRows = {}; }

function clearRgbMemory() { lastRgbByKey = {}; }

/** 记住一行最近一次带颜色成分的 RGB（transparent 字面量没有颜色信息，跳过）。 */
function rememberRgbValue(key, parsed, raw) {
  if (!parsed) return;
  if (String(raw || '').trim().toLowerCase() === 'transparent') return;
  if (parsed.a > 0 || parsed.r || parsed.g || parsed.b) {
    lastRgbByKey[key] = { r: parsed.r, g: parsed.g, b: parsed.b };
  }
}

/** 宽容写法归一化：把「人最自然的写法」补全成校验能直接吃掉的形态。
 *
 * - ``length`` 行敲纯数字 ``16`` → ``16px``（过去会标红，必须自己补单位）；
 * - ``blur`` 行敲纯数字 ``7`` → ``blur(7px)``（后端本来就接受 ``blur(7px)`` 与裸 ``7px``，
 *   但不接受无单位的 ``7``）；
 * - 其余（带单位/带百分号/负数/多 token）原样返回，交给 ``isSafeValue()`` 判定
 *   （``-4px`` 仍然非法：负圆角会让整条声明被浏览器丢弃）。
 *
 * 注意：只在面板侧归一化，后端与 loader 的校验保持严格 —— API 契约不变，
 * 手改 ``theme.json`` 或走 JSON 导入仍须写完整形态。
 */
function normalizeTypedValue(item, raw) {
  if (!item) return raw;
  if (!/^-?[0-9]{1,4}(?:\.[0-9]+)?$/.test(raw)) return raw;
  if (item.type === 'length') return raw + 'px';
  if (item.type === 'blur') return 'blur(' + raw + 'px)';
  // 时长裸数字补 s：CSS 的 animation-duration 不认无单位数字，后端也会补，
  // 面板这里先补上，用户敲 3 立刻看到 3s。
  if (item.type === 'time') return raw + 's';
  return raw;
}

/** 统一设置输入框的红框 / 无障碍非法标记 / 提示标题。 */
function setInputInvalid(input, item, bad) {
  if (!input) return;
  input.classList.toggle('is-bad', !!bad);
  if (bad) {
    input.setAttribute('aria-invalid', 'true');
    input.title = invalidInputHint(item);
  } else {
    input.removeAttribute('aria-invalid');
    input.title = '';
  }
}

/* ============================================================================
 * 6. DOM 帮手
 * ==========================================================================*/

function el(tag, props, children) {
  var node = document.createElement(tag);
  if (props) {
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === null || v === undefined) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style') node.setAttribute('style', v);
      else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
  }
  (children || []).forEach(function (c) { if (c) node.appendChild(c); });
  return node;
}

function $(id) { return document.getElementById(id); }

/** kind: 'ok' | 'error' | 空 —— 只影响配色，不影响文案。 */
function showToast(message, kind) {
  var node = $('toast');
  node.textContent = message;
  node.classList.toggle('is-ok', kind === 'ok');
  node.classList.toggle('is-error', kind === 'error');
  node.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(function () { node.classList.remove('show'); }, 3000);
}

/** kind: 'idle' | 'busy' | 'ok' | 'error' | 'warn' —— 底部状态点配色。 */
function setStatus(text, kind) {
  var node = $('status');
  if (!node) return;
  node.textContent = text;
  node.dataset.kind = kind || 'idle';
}

/** kind: 'ok' | 'warn' | 'error' —— 左侧色条与配色。传空文案即收起。 */
function showNotice(kind, text) {
  var node = $('notice');
  if (!node) return;
  if (!text) {
    node.hidden = true;
    node.className = 'notice';
    var body = $('notice-text');
    if (body) body.textContent = '';
    return;
  }
  node.className = 'notice is-' + kind;
  var target = $('notice-text') || node;
  target.textContent = text;
  node.hidden = false;
}

function hideNotice() { showNotice('ok', ''); }

/** 顶部细进度条：读取/应用期间给一个非阻塞的「在忙」信号。 */
function setLoading(loading) {
  document.body.classList.toggle('is-loading', !!loading);
}

/* ============================================================================
 * 7. 渲染编辑器
 * ==========================================================================*/

var rowsByKey = {};   // key → { hexInput, colorInput, alpha, alphaVal, textInput, rowEl, syncFn }

var groupNodes = {};   // group 名 → <section class="group">

function buildEditor() {
  var host = $('groups');
  host.textContent = '';

  CATALOG.forEach(function (group) {
    var key = group.group;
    var body = el('div', { class: 'group-body' });
    var count = el('span', { class: 'group-count' });
    var head = el('div', {
      class: 'group-head',
      role: 'button',
      tabindex: '0',
      'aria-expanded': state.collapsed[key] ? 'false' : 'true',
      'aria-label': key + ' 分组（点击展开/收起）',
      onclick: function () { toggleGroup(key); },
      onkeydown: function (event) {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault();
          toggleGroup(key);
        }
      }
    }, [
      el('span', { class: 'group-caret', 'aria-hidden': 'true', text: '▶' }),
      el('span', { class: 'group-title', text: key }),
      count
    ]);
    var wrap = el('section', { class: 'group' + (state.collapsed[key] ? ' is-collapsed' : '') }, [head, body]);
    groupNodes[key] = wrap;

    group.items.forEach(function (item) { body.appendChild(buildRow(item, count)); });

    host.appendChild(wrap);
  });

  refreshCounts();
  updateGroupToggleLabel();
}

function toggleGroup(key) {
  state.collapsed[key] = !state.collapsed[key];
  var node = groupNodes[key];
  if (!node) return;
  node.classList.toggle('is-collapsed', !!state.collapsed[key]);
  var head = node.querySelector('.group-head');
  if (head) head.setAttribute('aria-expanded', state.collapsed[key] ? 'false' : 'true');
  updateGroupToggleLabel();
}

function allCollapsed() {
  return CATALOG.every(function (group) { return !!state.collapsed[group.group]; });
}

function updateGroupToggleLabel() {
  var btn = $('btn-toggle-groups');
  if (btn) btn.textContent = allCollapsed() ? '全部展开' : '全部收起';
}

function toggleAllGroups() {
  var collapse = !allCollapsed();
  CATALOG.forEach(function (group) {
    state.collapsed[group.group] = collapse;
    var node = groupNodes[group.group];
    if (!node) return;
    node.classList.toggle('is-collapsed', collapse);
    var head = node.querySelector('.group-head');
    if (head) head.setAttribute('aria-expanded', collapse ? 'false' : 'true');
  });
  updateGroupToggleLabel();
}

/** 当前模式下的「原生参考值」：暗色优先 darkNative，没有就退回亮色原生值。 */
function nativeOf(item) {
  if (state.mode === 'dark' && item.darkNative !== undefined) return item.darkNative;
  return item.native || '';
}

/** placeholder 展示原生参考值；太长的不塞进输入框，免得像噪声。 */
function placeholderFor(item) {
  var native = nativeOf(item);
  if (native && native.length <= 28) return '原生 ' + native;
  return '留空 = 原生';
}

function buildRow(item, countNode) {
  var isColor = item.type === 'color';
  var isImage = item.type === 'image';
  var isSwitch = item.type === 'switch';

  var stateTag = el('span', { class: 'row-state' });
  var label = el('div', { class: 'row-label', title: item.key }, [
    el('span', { class: 'label-line' }, [
      el('span', { class: 'label-main', text: item.label }),
      stateTag
    ]),
    el('span', { class: 'k', text: item.key })
  ]);

  var colorInput = null;
  var hexInput = null;
  var alpha = null;
  var alphaVal = null;
  var textInput = null;
  var nativeCell = null;
  var imageField = null;
  var imgSwatch = null;
  var switchInput = null;
  var switchField = null;

  if (isSwitch) {
    // 开关控件：勾选 = 1（原生观感），未勾选 = 0（完全清透）。
    // 用 '1' / '0' 两个字符串写进 edited，和 number 变量共用后端校验。
    switchInput = el('input', {
      type: 'checkbox', class: 'veil-switch',
      'aria-label': item.label
    });
    switchInput.addEventListener('change', function () {
      markEdited(item.key, switchInput.checked ? '1' : '0');
      syncRow(item.key);
    });
    switchField = el('div', { class: 'field switch-field' }, [
      switchInput,
      el('span', { class: 'switch-text', text: '开关' })
    ]);
    nativeCell = el('span', {
      class: 'row-native',
      title: '原生观感 = 打开',
      text: '原生 开'
    });
  }

  if (isColor) {
    colorInput = el('input', {
      type: 'color', class: 'swatch', value: '#000000',
      'aria-label': item.label + ' 色板'
    });
    hexInput = el('input', {
      type: 'text',
      class: 'hex',
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: placeholderFor(item),
      'aria-label': item.label + ' 颜色值',
      oninput: function () {
        var raw = hexInput.value.trim();
        if (!raw) { clearRow(item.key); setInputInvalid(hexInput, item, false); syncRow(item.key, { keepHex: true }); return; }
        var parsed = parseColor(raw);
        if (!parsed) { setInputInvalid(hexInput, item, true); markRowInvalid(item.key, true); return; }
        setInputInvalid(hexInput, item, false);
        markRowInvalid(item.key, false);
        // 只有 6/3 位 hex 没有自己的 alpha，才继承当前值的 alpha；transparent、
        // 4/8 位 hex、rgba(...) 一律用解析出的 alpha。旧实现一律走 currentAlpha()，
        // 而 currentAlpha 对全透明返回 1 → 输入 "transparent" 的过程中被记成
        // rgba(0,0,0,1) 纯黑，Ctrl+Enter（不要求失焦）直接写盘。
        var isPlainHex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw);
        var alphaOut = isPlainHex ? currentAlpha(item.key) : parsed.a;
        rememberRgbValue(item.key, parsed, raw);
        markEdited(item.key, toRgba(parsed.r, parsed.g, parsed.b, alphaOut));
        // keepHex：输入框保留用户正在敲的原文，否则 "#ff8" 会被当成 3 位色改写，
        // 后续按键拼出用户没输入过的值（实测 #ff8800 → #ffff8880）。
        syncRow(item.key, { keepHex: true });
      },
      onchange: function () {
        // 失焦/回车才算定稿：只有此时才从 4/8 位 hex 里取 alpha 并归一化展示。
        // 逐键过程中保持原有 alpha，否则 6 位色 "#ff8800" 的 4 位前缀 "#ff88"
        // 会被当成 53% 透明的 4 位色，把用户输入的实色变成半透明。
        var raw = hexInput.value.trim();
        if (!raw) return;
        var parsed = parseColor(raw);
        if (!parsed) { setInputInvalid(hexInput, item, true); markRowInvalid(item.key, true); return; }
        setInputInvalid(hexInput, item, false);
        markRowInvalid(item.key, false);
        rememberRgbValue(item.key, parsed, raw);
        markEdited(item.key, toRgba(parsed.r, parsed.g, parsed.b, parsed.a));
        syncRow(item.key);
      }
    });

    alpha = el('input', {
      type: 'range', min: '0', max: '100', step: '1', value: '100',
      'aria-label': item.label + ' 不透明度',
      oninput: function () {
        var a = Number(alpha.value) / 100;
        var parsed = parseColor(displayValue(item.key));
        // 不是靠猜颜色：全透明行若记得上一次的 RGB（lastRgbByKey），就沿用它
        // 把不透明度拖回来 —— 旧实现此时滑块 disabled、currentAlpha 强制 1，
        // 用户再也调不回半透明。只有完全没有 RGB 记忆时才不猜（否则纯黑）。
        var rgb = parsed && parsed.a > 0 ? parsed : lastRgbByKey[item.key];
        if (!rgb) { syncRow(item.key); return; }
        rememberRgbValue(item.key, rgb, '');
        markEdited(item.key, toRgba(rgb.r, rgb.g, rgb.b, a));
        syncRow(item.key);
      }
    });
    alphaVal = el('span', { class: 'alpha-val', text: '100%' });

    colorInput.addEventListener('input', function () {
      var parsed = parseColor(colorInput.value);
      if (!parsed) return;
      rememberRgbValue(item.key, parsed, '#');
      markEdited(item.key, toRgba(parsed.r, parsed.g, parsed.b, currentAlpha(item.key)));
      syncRow(item.key);
    });
  } else if (isImage) {
    // 背景图行：合法值只有 none 或 url("…/backgrounds/<文件>")。选图先由后端落盘并
    // 回读成 url(...)，再走既有 markEdited / cleared 机制 —— 提交、脏标记、collect()
    // 都不另开路径，applyTheme 里照旧提交。
    imgSwatch = el('div', { class: 'img-swatch', 'aria-hidden': 'true' });
    var imageFileInput = el('input', {
      type: 'file',
      class: 'visually-hidden',
      accept: 'image/png,image/jpeg,image/webp,image/gif',
      tabindex: '-1',
      'aria-label': item.label + ' 选择图片文件',
      onchange: function () {
        var file = imageFileInput.files && imageFileInput.files[0];
        if (file) pickBackgroundImage(item, file, imageFileInput);
      }
    });
    var pickBtn = el('button', {
      type: 'button', class: 'btn btn-mini', 'data-act': 'pick', text: '选择图片',
      'aria-label': '选择' + item.label,
      onclick: function () { if (imageFileInput) imageFileInput.click(); }
    });
    var clearImageBtn = el('button', {
      type: 'button', class: 'btn btn-mini btn-ghost', 'data-act': 'clear', text: '清除',
      'aria-label': '清除' + item.label,
      onclick: function () {
        // 与 .row-clear 等价：走 cleared 机制，提交空串 = 删掉 theme.json 里的这一项。
        if (!isDirty(item.key) && serverValue(item.key) === null) {
          showToast('该行本来就是原生值');
          return;
        }
        var removed = clearRow(item.key);
        syncRow(item.key);
        if (!removed) showToast('已撤销本行改动');
      }
    });
    // 第二列位置放整块图片控件，并横跨「色块 + 编辑框」两列；行内没有文本输入框，
    // 因此这一行的子节点只有 4 个（标签 / 图片控件 / 原生值 / 清空）。
    imageField = el('div', {
      class: 'field image-field',
      style: 'grid-column: 2 / span 2;'
    }, [
      imgSwatch,
      el('div', { class: 'img-actions' }, [
        pickBtn,
        clearImageBtn,
        el('span', { class: 'img-hint', text: '图片会盖在背景色之上' })
      ]),
      imageFileInput
    ]);
    nativeCell = el('span', {
      class: 'row-native',
      title: nativeOf(item) ? '原生值：' + nativeOf(item) : '该变量没有统一的原生值',
      text: nativeOf(item) ? '原生 ' + nativeOf(item) : ''
    });
  } else {
    textInput = el('input', {
      type: 'text',
      class: 'raw',
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: placeholderFor(item),
      'aria-label': item.label,
      oninput: function () {
        // 注意：这里不能对 value 做 trim 后再回写。多 token 的值（阴影、字体族）
        // 是逐个字符敲出来的，行尾空格一被 trim 掉，下一个 token 就会粘在前一个
        // 上 —— 实测 "0 2px 4px red" 被录成 "02px4px red"，"Segoe UI" 变成
        // "SegoeUI"。所以：校验用 trim 后的值，显示保留用户原文。
        var raw = textInput.value;
        var trimmed = normalizeTypedValue(item, raw.trim());
        if (!trimmed) { clearRow(item.key); setInputInvalid(textInput, item, false); syncRow(item.key, { keepText: true }); return; }
        if (!isSafeValue(item.key, trimmed)) {
          // 非法值只标红还不够：之前 edited 里仍留着上一个合法值，applyTheme
          // 会把它提交上去并报「已应用」，用户以为刚敲的值生效了。
          // 这里回滚到上一个合法编辑值（没有就退回服务器值）并记入非法行集合，
          // applyTheme 见到红框行会直接阻止应用。
          setInputInvalid(textInput, item, true);
          markRowInvalid(item.key, true);
          rollbackRowToLastValid(item.key);
          syncRow(item.key, { keepText: true });
          return;
        }
        setInputInvalid(textInput, item, false);
        markRowInvalid(item.key, false);
        markEdited(item.key, trimmed);
        syncRow(item.key, { keepText: true });
      },
      onchange: function () {
        // 失焦/回车时定稿：去掉首尾空白，再做一次完整校验。
        var trimmed = normalizeTypedValue(item, textInput.value.trim());
        textInput.value = trimmed;
        if (!trimmed) { clearRow(item.key); setInputInvalid(textInput, item, false); syncRow(item.key); return; }
        if (!isSafeValue(item.key, trimmed)) {
          setInputInvalid(textInput, item, true);
          markRowInvalid(item.key, true);
          rollbackRowToLastValid(item.key);
          syncRow(item.key);
          return;
        }
        setInputInvalid(textInput, item, false);
        markRowInvalid(item.key, false);
        markEdited(item.key, trimmed);
        syncRow(item.key);
      }
    });
    nativeCell = el('span', {
      class: 'row-native',
      title: nativeOf(item) ? '原生值：' + nativeOf(item) : '该变量没有统一的原生值',
      text: nativeOf(item) ? '原生 ' + nativeOf(item) : ''
    });
  }

  var field = imageField || switchField ||
    el('div', { class: 'field' }, [isColor ? hexInput : textInput]);

  var alphaCell = el('div', { class: 'alpha-cell' });
  if (isColor) {
    alphaCell.appendChild(el('span', { class: 'alpha-label', text: '透明' }));
    alphaCell.appendChild(alpha);
    alphaCell.appendChild(alphaVal);
  }

  var clearBtn = el('button', {
    type: 'button', class: 'row-clear', text: '清空',
    title: '清空该行 = 回退到 N.E.K.O 原生值',
    'aria-label': '清空 ' + item.label,
    onclick: function () {
      // 干净且服务器上没有值的行：「清空」无事可做，不能凭空造出一项改动。
      if (!isDirty(item.key) && serverValue(item.key) === null) {
        showToast('该行本来就是原生值');
        return;
      }
      var removed = clearRow(item.key);
      syncRow(item.key);
      if (!removed) showToast('已撤销本行改动');
    }
  });

  // 网格五列：标签 | 色块或类型标签 | 编辑框 | 透明度或原生值 | 清空
  // 非颜色行没有色块，用同宽类型标签占位，保证输入框左边缘对齐。
  // 图片行特殊：整块图片控件占「色块 + 编辑框」两列（见上面的 image-field），
  // 所以这一行的子节点是 4 个而不是 5 个。
  var rowChildren;
  if (isImage) {
    rowChildren = [label, imageField, nativeCell || el('span', {}), clearBtn];
  } else {
    rowChildren = [
      label,
      isColor && colorInput ? colorInput : el('span', { class: 'type-tag', text: TYPE_LABEL[item.type] || item.type }),
      field,
      isColor ? alphaCell : (nativeCell || el('span', {})),
      clearBtn
    ];
  }
  var rowEl = el('div', { class: 'row' }, rowChildren);

  var hint = null;
  if (item.hint) {
    hint = el('div', { class: 'hint', title: item.hint, text: item.hint });
  }

  var container = el('div', { class: 'row-wrap' }, [rowEl, hint]);
  rowsByKey[item.key] = {
    rowEl: rowEl, colorInput: colorInput, hexInput: hexInput,
    alpha: alpha, alphaVal: alphaVal, textInput: textInput, clearBtn: clearBtn,
    nativeCell: nativeCell, stateTag: stateTag, container: container,
    imgSwatch: imgSwatch, imageField: imageField,
    switchInput: switchInput,
    item: item, countNode: countNode
  };

  countNode.dataset.total = String(Number(countNode.dataset.total || 0) + 1);
  return container;
}

/* ---------------- 背景图片上传（聊天背景图行专用） ----------------
 * 图片不能像颜色那样直接写进变量：文件要先交给后端落盘（校验体积/类型），
 * 再拿回 http://127.0.0.1:48916/... 的地址拼成 url("...")。所以这里只做
 * 「读文件 → 调 import_background → markEdited」，提交仍由 applyTheme 完成。 */

function pickBackgroundImage(item, file, input) {
  var reader = new FileReader();
  reader.onload = function () {
    var raw = String(reader.result || '');
    var comma = raw.indexOf(',');
    var base64 = comma >= 0 ? raw.slice(comma + 1) : '';
    if (!base64) {
      showToast('读取图片失败', 'error');
      if (input) input.value = '';
      return;
    }
    uploadBackgroundImage(item, file.name, base64, input);
  };
  reader.onerror = function () {
    var why = reader.error && reader.error.message ? reader.error.message : file.name;
    showNotice('error', '读取图片失败：' + why);
    showToast('读取图片失败', 'error');
    if (input) input.value = '';
  };
  reader.readAsDataURL(file);
}

async function uploadBackgroundImage(item, filename, base64, input) {
  setBusy(true, '正在上传背景图片…');
  try {
    var result = await callPlugin('import_background', { filename: filename, data: base64 });
    var url = result && result.url ? String(result.url) : '';
    if (!url) throw new Error('后端没有返回图片地址');
    markEdited(item.key, 'url("' + url + '")');
    syncRow(item.key);
    setStatus('已选择背景图片', 'ok');
    showToast('已选择背景图片', 'ok');
  } catch (error) {
    showNotice('error', '背景图片上传失败：' + pluginErrorMessage(error));
    showToast('背景图片上传失败', 'error');
    setStatus('背景图片上传失败', 'error');
  } finally {
    // 清空 input：否则再选同一个文件不会触发 change。
    if (input) input.value = '';
    setBusy(false);
  }
}

function currentAlpha(key) {
  var raw = Object.prototype.hasOwnProperty.call(editedMap(), key) ? editedMap()[key] : displayValue(key);
  var parsed = parseColor(raw);
  // 当前值全透明（transparent / rgba(...,0)）时不能把 alpha=0 继承给新颜色：
  // 用户从色板选一个实色，提交的却是 rgba(...,0)，面板显示「已改」而画面
  // 依旧完全透明 —— 看起来就是「改了没反应」。色板选色默认按实色处理。
  // 注意：alpha 滑块不走这里，它用 lastRgbByKey 里记住的 RGB 调不透明度。
  if (!parsed || parsed.a === 0) return 1;
  return parsed.a;
}

/** 把某一行的控件同步成当前状态。opts.keepHex=true 时不动正在编辑的 hex 输入框。 */
function syncRow(key, opts) {
  var ref = rowsByKey[key];
  if (!ref) return;
  var value = displayValue(key);
  var dirty = isDirty(key);

  ref.rowEl.classList.toggle('is-dirty', dirty);

  if (ref.stateTag) {
    var cleared = Object.prototype.hasOwnProperty.call(clearedMap(), key);
    ref.stateTag.textContent = dirty ? (cleared ? '已清空' : '已改') : '';
  }

  if (ref.hexInput) ref.hexInput.placeholder = placeholderFor(ref.item);
  if (ref.textInput) ref.textInput.placeholder = placeholderFor(ref.item);
  if (ref.nativeCell) {
    var native = nativeOf(ref.item);
    ref.nativeCell.textContent = native ? '原生 ' + native : '';
    ref.nativeCell.title = native ? '原生值：' + native : '该变量没有统一的原生值';
  }

  if (ref.item.type === 'color') {
    var parsed = parseColor(value);
    var fullyTransparent = !!parsed && parsed.a === 0;
    if (parsed) {
      // 记住最近一次带颜色的 RGB：transparent 之后拖动 alpha 滑块要靠它找回颜色。
      // rememberRgbValue 内部会跳过 transparent / rgba(...,0) 字面量。
      rememberRgbValue(key, parsed, value);
      // 全透明的 rgba(...,0) / #0000 若按 RGB 显示成 #000000，用户会以为颜色
      // 被改成了黑色；这里显式显示 transparent，和 alpha=0% 一起表达真实状态。
      if (!(opts && opts.keepHex)) {
        ref.hexInput.value = fullyTransparent ? 'transparent' : toHex(parsed.r, parsed.g, parsed.b);
      }
      ref.colorInput.value = toHex(parsed.r, parsed.g, parsed.b);
      ref.alpha.value = String(Math.round(parsed.a * 100));
      ref.alphaVal.textContent = Math.round(parsed.a * 100) + '%';
      setInputInvalid(ref.hexInput, ref.item, false);
      markRowInvalid(key, false);
    } else {
      // 值是 inherit / 空 等非颜色字面量：文本原样展示，控件退回中性
      // 色块也要跟着退，否则清空/重置后色块仍显示上一次的颜色，看起来像没生效。
      ref.hexInput.value = value || '';
      if (ref.colorInput) ref.colorInput.value = '#000000';
      ref.alpha.value = '100';
      ref.alphaVal.textContent = '100%';
    }
    // transparent / inherit / 空 都没有当前 RGB：滑块只在「有 RGB 记忆」时可用
    // （拖动会沿用上一次的颜色，见 lastRgbByKey）。完全没记忆时置灰，否则拖动
    // 会得到 rgba(0,0,0,x) 纯黑半透明，用户看到的是「一拖就变黑」。
    if (ref.alpha) {
      var hasRgbMemory = !!lastRgbByKey[key];
      ref.alpha.disabled = !!state.busy || !parsed || (fullyTransparent && !hasRgbMemory);
      if (!parsed) {
        ref.alpha.title = '当前值没有颜色成分（transparent / inherit / 空）；先填一个颜色再调不透明度';
      } else if (fullyTransparent && !hasRgbMemory) {
        ref.alpha.title = '当前值没有颜色成分（transparent）；先填一个颜色再调不透明度';
      } else if (fullyTransparent) {
        ref.alpha.title = '拖动不透明度会沿用上一次的颜色';
      } else {
        ref.alpha.title = '';
      }
    }
  } else if (ref.item.type === 'switch') {
    if (ref.switchInput) {
      // 显示值可能是 '1' / '0' / 空（空 = 服务器没有值 = 原生观感 = 打开）
      var raw = value === null || value === undefined ? '' : String(value).trim();
      ref.switchInput.checked = raw === '' ? true : !(raw === '0' || raw === '0.0');
    }
  } else if (ref.item.type === 'image') {
    // 有图才画图；无图留空，CSS 用斜纹表示「没有背景图」。切换模式/重新读取后
    // 这里会显示对应模式的 url(...)。
    if (ref.imgSwatch) {
      var imgValue = value ? String(value) : '';
      var hasImage = !!imgValue && imgValue !== 'none' && imgValue.indexOf('url(') === 0;
      ref.imgSwatch.style.backgroundImage = hasImage ? imgValue : '';
      ref.imgSwatch.title = hasImage ? '当前背景图片' : '未设置背景图片（跟随原生）';
    }
    markRowInvalid(key, false);
  } else {
    if (!(opts && opts.keepText)) {
      ref.textInput.value = value || '';
      // 回显的是当前有效值，红框/非法行标记必须一起清掉；
      // 否则「清空」或撤销后红框还留着，applyTheme 会一直被非法行拦住。
      setInputInvalid(ref.textInput, ref.item, false);
      markRowInvalid(key, false);
    }
  }

  refreshCounts();
  renderPreview();
  renderDump();
  updateButtons();
  // 「只看改动」开着时，某行被改回干净状态就该立刻从列表里消失
  if (state.onlyDirty) applyFilters();
}

function syncAll() {
  Object.keys(rowsByKey).forEach(syncRow);
  refreshCounts();
  renderPreview();
  renderDump();
  updateButtons();
}

function refreshCounts() {
  CATALOG.forEach(function (group) {
    var total = group.items.length;
    var dirty = group.items.filter(function (item) { return isDirtyAny(item.key); }).length;
    // 找到该组的计数节点：通过任意一行的 countNode
    var node = rowsByKey[group.items[0].key] && rowsByKey[group.items[0].key].countNode;
    if (!node) return;
    node.textContent = '';
    if (dirty) {
      node.appendChild(el('span', { class: 'is-dirty-count', text: dirty + ' 项已改' }));
      node.appendChild(el('span', { class: 'dot', text: '·' }));
    }
    node.appendChild(el('span', { text: total + ' 项' }));
  });
}

/* ---------------- 过滤：搜索 / 只看改动 ---------------- */

/** 该键在任一模式（亮/暗）里是否被改过或清空过。 */
function isDirtyAny(key) {
  return Object.prototype.hasOwnProperty.call(state.edited.light, key) ||
    Object.prototype.hasOwnProperty.call(state.edited.dark, key) ||
    Object.prototype.hasOwnProperty.call(state.cleared.light, key) ||
    Object.prototype.hasOwnProperty.call(state.cleared.dark, key);
}

function rowMatches(item, query) {
  if (state.onlyDirty && !isDirtyAny(item.key)) return false;
  if (!query) return true;
  var hay = (item.label + ' ' + item.key + ' ' + (item.hint || '')).toLowerCase();
  return hay.indexOf(query) !== -1;
}

/**
 * 把「搜索词 + 只看改动」应用到行与分组上：
 * - 行级：row-wrap[hidden]
 * - 组级：没有命中行的组整体隐藏
 * - 过滤时强制展开，否则命中项藏在折叠组里等于没找到
 */
function applyFilters() {
  var query = (state.filter || '').trim().toLowerCase();
  var filtering = !!query || state.onlyDirty;
  var shown = 0;

  CATALOG.forEach(function (group) {
    var section = groupNodes[group.group];
    var visible = 0;
    group.items.forEach(function (item) {
      var ref = rowsByKey[item.key];
      if (!ref) return;
      var match = rowMatches(item, query);
      if (ref.container) ref.container.hidden = !match;
      if (match) { visible += 1; shown += 1; }
    });
    if (section) {
      section.hidden = visible === 0;
      section.classList.toggle('is-collapsed', !filtering && !!state.collapsed[group.group]);
      var head = section.querySelector('.group-head');
      if (head) head.setAttribute('aria-expanded', section.classList.contains('is-collapsed') ? 'false' : 'true');
    }
  });

  var noMatch = $('no-match');
  if (noMatch) noMatch.hidden = !(filtering && shown === 0);

  var clear = $('search-clear');
  if (clear) clear.hidden = !query;
}

function setFilter(value) {
  state.filter = value || '';
  applyFilters();
}

function clearFilter() {
  var input = $('row-search');
  if (input) input.value = '';
  state.filter = '';
  applyFilters();
  if (input) input.focus();
}

function setOnlyDirty(on) {
  state.onlyDirty = !!on;
  applyFilters();
}

/* ============================================================================
 * 8. 预览（内联样式，纯本地模拟）
 * ==========================================================================*/

function pvValue(key, fallback) {
  var v = displayValue(key);
  if (!v) return fallback || '';
  if (v.indexOf('--') === 0) return fallback || '';
  return v;
}

function renderPreview() {
  $('preview-mode').textContent = state.mode === 'dark' ? '暗色' : '亮色';

  var chatBg = pvValue('--nts-chat-bg', state.mode === 'dark' ? '#1f242a' : '#eef3f8');
  var panelBg = pvValue('--nts-chat-panel-bg', '');
  var radius = pvValue('--nts-radius', '12px');
  // 预览必须按真实消费方取圆角：外壳读 --nts-shell-radius、气泡读
  // --nts-bubble-radius，都没配时才回退通用 --nts-radius。之前全部读通用值，
  // 于是改「聊天气泡圆角」预览纹丝不动，看起来像没生效。
  var shellRadius = pvValue('--nts-shell-radius', radius);
  var bubbleRadius = pvValue('--nts-bubble-radius', radius);
  var blur = pvValue('--nts-chat-blur', '');
  // 契约允许裸长度（"18px"），真正落盘前 loader/后端会归一成 blur(18px)。
  // 预览直接拿裸长度写 backdropFilter 是非法值，浏览器整条丢弃 —— 于是
  // 明明改了模糊，预览却毫无反应（真机上更会被误判成主题没生效）。
  // 但拼接前必须确认单位合法：blur(18%) / blur(2vw) 同样是非法值，
  // 旧实现会无条件拼上去，等于把「面板校验放过的非法输入」带进预览。
  var blurCss = '';
  if (blur) {
    if (RE_BLUR.test(blur)) blurCss = blur;
    else if (RE_BLUR_LENGTH.test(blur)) blurCss = 'blur(' + blur + ')';
    else if (RE_ZERO.test(blur)) blurCss = 'blur(0)';
  }

  /* 「聊天背景虚化」开关（--nts-bubble-veil，0–1 乘子）。真机上它同时缩放气泡
   * 白纱底的不透明度与 backdrop 模糊半径 —— 预览必须真算一遍，否则拨开关时
   * 预览纹丝不动，会被当成「开关没生效」（真机其实是生效的，这种错觉最坑）。
   * 只在服务器确实有这个变量时才介入，未配置时保持预览原本的观感。 */
  var veilRaw = pvValue('--nts-bubble-veil', '');
  var veilActive = veilRaw !== '';
  var veil = 1;
  if (veilActive) {
    if (RE_NUMBER.test(veilRaw)) veil = parseFloat(veilRaw);
    else if (RE_PERCENT.test(veilRaw)) veil = parseFloat(veilRaw) / 100;
    if (!isFinite(veil) || veil < 0) veil = 0;
    if (veil > 1) veil = 1;
  }
  var veilBlur = 'blur(' + Math.round(8 * veil * 100) / 100 + 'px) saturate(1.08)';
  // 开关为 1 时的原生观感（白纱底色），与 neko-chat-window.css 的
  // .compact-export-history-bubble 亮/暗两套值一致。
  var veilUserSheet = state.mode === 'dark' ? [33, 72, 118, 0.902] : [208, 231, 255, 0.8784];
  var veilAiSheet = state.mode === 'dark' ? [33, 45, 62, 0.878] : [255, 255, 255, 0.8784];

  var preview = $('preview');
  preview.style.background = chatBg;
  preview.style.borderRadius = shellRadius;
  if (panelBg) preview.style.backgroundColor = panelBg;
  preview.style.backdropFilter = blurCss;
  preview.style.webkitBackdropFilter = blurCss;
  preview.style.boxShadow = pvValue('--nts-shadow', '');

  // 背板（消息列表底板）在预览里对应 .pv-body。圆角必须单独取
  // --nts-chat-panel-radius：它和「通用圆角」是两个不同消费方，读错了
  // 就会出现「改了背板圆角，预览里动的却是按钮」这种假象。
  var panelRadius = pvValue('--nts-chat-panel-radius', '');
  // 聊天背景图：与「背板底色」同层，图片画在 background-color 之上（所以预览里
  // 只要两者都设，看到的就是图片）。cover/center/no-repeat 必须成套设置，
  // 否则 4K 图会按原始像素平铺成一团马赛克。
  var panelImage = pvValue('--nts-chat-bg-image', '');
  var hasPanelImage = !!panelImage && panelImage !== 'none' && panelImage.indexOf('url(') === 0;
  // 背景图亮度：与 CSS 同一套算法 —— 黑色蒙版 alpha = 1 - 亮度，叠在图片前面。
  // 预览必须跟着变，否则用户拨了亮度、预览里图片纹丝不动，会以为没生效。
  var imgBrightRaw = pvValue('--nts-chat-bg-image-brightness', '');
  var imgBright = 1;
  if (imgBrightRaw !== '') {
    var bNum = RE_NUMBER.test(imgBrightRaw) ? parseFloat(imgBrightRaw) : NaN;
    if (isNaN(bNum) && RE_PERCENT.test(imgBrightRaw)) bNum = parseFloat(imgBrightRaw) / 100;
    if (!isNaN(bNum)) imgBright = Math.max(0, Math.min(1, bNum));
  }
  var imgScrim = hasPanelImage && imgBright < 1
    ? 'linear-gradient(rgba(0,0,0,' + (1 - imgBright).toFixed(4) + '), rgba(0,0,0,'
      + (1 - imgBright).toFixed(4) + ')), '
    : '';
  liveStyle($('pv-body'), {
    background: 'transparent',
    borderRadius: panelRadius || '0px'
  });
  var pvBody = $('pv-body');
  if (pvBody) {
    pvBody.style.backgroundImage = hasPanelImage ? (imgScrim + panelImage) : '';
    pvBody.style.backgroundSize = hasPanelImage ? 'cover' : '';
    pvBody.style.backgroundPosition = hasPanelImage ? 'center center' : '';
    pvBody.style.backgroundRepeat = hasPanelImage ? 'no-repeat' : '';
    // 顶部渐隐（用户说的「图片最上边那层雾」）：与应用同一条 mask 渐变的 alpha 乘法。
    var topFadeRaw = pvValue('--nts-chat-top-fade', '');
    if (topFadeRaw === '') {
      pvBody.style.maskImage = '';
      pvBody.style.webkitMaskImage = '';
    } else {
      var fadeNum = RE_NUMBER.test(topFadeRaw) ? parseFloat(topFadeRaw) : NaN;
      if (isNaN(fadeNum) && RE_PERCENT.test(topFadeRaw)) fadeNum = parseFloat(topFadeRaw) / 100;
      if (isNaN(fadeNum)) fadeNum = 1;
      var fade = Math.max(0, Math.min(1, fadeNum));
      var fadeCss = 'linear-gradient(to bottom, rgba(0,0,0,' + (1 - fade).toFixed(4) + ') 0px, rgba(0,0,0,'
        + (1 - 0.22 * fade).toFixed(4) + ') 12px, rgba(0,0,0,1) 28px)';
      pvBody.style.maskImage = fadeCss;
      pvBody.style.webkitMaskImage = fadeCss;
    }
  }


  /* ---------- 面板光效 / 玻璃拟态（预览侧还原）----------
   * 「未配置 = 不动预览」，与真机的门控语义一致；每个乘子都真算，否则拨动
   * 控件时预览纹丝不动会被当成没生效。 */
  function pvNumber(key) {
    var raw = pvValue(key, '');
    if (raw === '') return null;
    var n = NaN;
    if (RE_NUMBER.test(raw)) n = parseFloat(raw);
    else if (RE_PERCENT.test(raw)) n = parseFloat(raw) / 100;
    if (isNaN(n)) return null;
    return clamp(n, 0, 1);
  }

  function pvLength(key) {
    var raw = pvValue(key, '');
    if (raw === '') return '';
    if (RE_LENGTH.test(raw) || RE_ZERO.test(raw)) return raw;
    if (/^[0-9]{1,4}(?:\.[0-9]+)?$/.test(raw)) return raw + 'px';
    return '';
  }

  /* 把任意 CSS 颜色按比例混到透明上 —— 真机用 color-mix，预览用 rgba 近似。
   * 颜色解析复用 parseColor，范围与校验器一致。 */
  function pvTint(color, amount) {
    var c = parseColor(color || '');
    if (!c || amount <= 0) return 'rgba(0,0,0,0)';
    var a = Math.round(clamp(c.a * amount, 0, 1) * 1000) / 1000;
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  }

  var glowColor = pvValue('--nts-panel-glow-color', '#ffffff');
  /* 与 CSS 同一条门控：外发光要求 strength 有值，其余按需。 */
  /* 与 CSS 的门控完全一致：外发光只要 color / strength / size 任一被配置就生效，
   * 其余取默认（strength 1、size 24px）。早期预览要求 strength 有值，导致用户
   * 只改「光晕颜色」时预览毫无光晕 —— 那正是最容易被误判成「改了没反应」的场景。 */
  var glowStrength = pvNumber('--nts-panel-glow-strength');
  var glowColorRaw = pvValue('--nts-panel-glow-color', '');
  var glowSizeRaw = pvValue('--nts-panel-glow-size', '');
  var glowOn = (glowColorRaw !== '' || glowStrength !== null || glowSizeRaw !== '');
  var glowAmount = glowStrength === null ? 1 : glowStrength;
  var glowSizePx = parseFloat(pvLength('--nts-panel-glow-size')) || 24;
  var borderColorRaw = pvValue('--nts-panel-border-color', '');
  var borderWidth = pvLength('--nts-panel-border-width');
  var cornerGlow = pvNumber('--nts-panel-corner-glow');
  var edgeGradient = pvNumber('--nts-panel-edge-gradient');
  var sheen = pvNumber('--nts-panel-sheen');
  var innerGlow = pvNumber('--nts-panel-inner-glow');
  var glassTintRaw = pvValue('--nts-panel-glass-tint', '');

  if (pvBody) {
    /* background-image 的**第一个**在最上层，所以光效层要 prepend。
     * 底下保持原有的「蒙版 + 背景图」。 */
    var below = hasPanelImage ? (imgScrim + panelImage) : '';
    var above = [];

    if (glassTintRaw) {
      var tint = parseColor(glassTintRaw);
      if (tint) above.push('linear-gradient(' + pvTint(glassTintRaw, 1) + ', '
        + pvTint(glassTintRaw, 1) + ')');
    }
    if (cornerGlow !== null && cornerGlow > 0) {
      ['0% 0%', '100% 0%', '0% 100%', '100% 100%'].forEach(function (pos) {
        above.push('radial-gradient(circle at ' + pos + ', '
          + pvTint(glowColor, cornerGlow * 0.95) + ', rgba(0,0,0,0) 34%)');
      });
    }
    if (sheen !== null && sheen > 0) {
      above.push('linear-gradient(135deg, ' + pvTint('#ffffff', sheen * 0.42)
        + ' 0%, rgba(0,0,0,0) 46%)');
    }
    if (glowOn && glowAmount > 0) {
      /* 外发光：一圈从透明过渡到发光色的径向渐变，厚度随 size×strength。 */
      var inner = Math.max(0, glowSizePx * 1.42 * glowAmount).toFixed(1);
      above.push('radial-gradient(ellipse at center, rgba(0,0,0,0) calc(100% - '
        + inner + 'px), ' + pvTint(glowColor, glowAmount * 0.55) + ' 100%)');
    }

    pvBody.style.backgroundImage = above.length
      ? (above.join(', ') + (below ? ', ' + below : ''))
      : below;
    if (hasPanelImage || above.length) {
      pvBody.style.backgroundRepeat = 'no-repeat';
      pvBody.style.backgroundSize = 'cover';
      pvBody.style.backgroundPosition = 'center center';
    }

    /* 描边：真机在 anchor::after 上，预览直接给 body 加 border。 */
    pvBody.style.border = (borderWidth || borderColorRaw)
      ? (borderWidth || '1.5px') + ' solid ' + (borderColorRaw || 'rgba(255,255,255,.55)')
      : '';

    /* 内侧边缘渐变 + 内阴影：预览里都用 inset 阴影表达。 */
    var glowShadows = [];
    if (edgeGradient !== null && edgeGradient > 0) {
      glowShadows.push('inset 0 0 ' + (glowSizePx * 0.9).toFixed(1) + 'px '
        + (glowSizePx * 0.12).toFixed(1) + 'px ' + pvTint(glowColor, edgeGradient));
    }
    if (innerGlow !== null && innerGlow > 0) {
      glowShadows.push('inset 0 0 ' + (18 * innerGlow).toFixed(1) + 'px '
        + (2 * innerGlow).toFixed(1) + 'px rgba(0,0,0,.35)');
    }
    pvBody.style.boxShadow = glowShadows.join(', ');
  }

  var fontFamily = pvValue('--nts-font-family', '');
  var fontSize = pvValue('--nts-font-size', '');
  preview.style.fontFamily = fontFamily || '';
  if (fontSize) preview.style.fontSize = fontSize;

  liveStyle($('pv-topbar'), {
    background: pvValue('--nts-topbar-bg', 'transparent'),
    color: pvValue('--nts-topbar-text', state.mode === 'dark' ? '#e0e0e0' : '#24445a')
  });

  /* 气泡底色：设了「气泡背景」变量时它接管底色（虚化让位，与 CSS 的
   * yieldsTo 语义一致），但 backdrop 模糊仍随开关缩放。 */
  var userBgRaw = pvValue('--nts-user-bubble-bg', '');
  var aiBgRaw = pvValue('--nts-ai-bubble-bg', '');
  styleBubble($('pv-user'), {
    background: userBgRaw
      ? userBgRaw
      : (veilActive ? veilSheet(veilUserSheet, veil) : '#44b7fe'),
    color: pvValue('--nts-user-bubble-text',
      veilActive ? (state.mode === 'dark' ? '#dceaff' : '#142033') : '#ffffff'),
    borderColor: pvValue('--nts-user-bubble-border', 'transparent'),
    radius: bubbleRadius,
    align: 'flex-end',
    blur: veilActive ? veilBlur : ''
  });

  styleBubble($('pv-ai'), {
    background: aiBgRaw
      ? aiBgRaw
      : (veilActive
        ? veilSheet(veilAiSheet, veil)
        : (state.mode === 'dark' ? 'rgba(42,123,196,0.18)' : '#ffffff')),
    color: pvValue('--nts-ai-bubble-text',
      veilActive ? (state.mode === 'dark' ? '#e8f0fb' : '#273042') : (state.mode === 'dark' ? '#e0e0e0' : '#24445a')),
    borderColor: pvValue('--nts-ai-bubble-border', 'transparent'),
    radius: bubbleRadius,
    align: 'flex-start',
    blur: veilActive ? veilBlur : ''
  });

  $('pv-link').style.color = pvValue('--nts-link', '#2a7bc4');

  liveStyle($('pv-chip'), {
    background: pvValue('--nts-chip-bg', 'transparent'),
    color: pvValue('--nts-chip-text', state.mode === 'dark' ? '#e0e0e0' : '#24445a'),
    borderColor: pvValue('--nts-rec-border', 'rgba(0,0,0,0.12)'),
    borderRadius: '999px'
  });

  liveStyle($('pv-input-area'), {
    background: pvValue('--nts-input-bg', state.mode === 'dark' ? 'rgba(40,40,40,0.65)' : 'rgba(255,255,255,0.5)'),
    borderTopColor: pvValue('--nts-input-border', 'rgba(0,0,0,0.06)'),
    blur: blurCss
  });

  liveStyle($('pv-input'), {
    background: pvValue('--nts-input-bg', 'transparent'),
    color: pvValue('--nts-input-text', state.mode === 'dark' ? '#e0e0e0' : '#24445a'),
    borderColor: pvValue('--nts-input-border', 'rgba(0,0,0,0.1)'),
    borderRadius: radius
  });

  liveStyle($('pv-send'), {
    background: pvValue('--nts-send-bg', '#44b7fe'),
    color: pvValue('--nts-send-text', '#ffffff'),
    borderRadius: radius
  });
}

function liveStyle(node, cfg) {
  if (!node) return;
  if (cfg.background !== undefined) node.style.backgroundColor = cfg.background;
  if (cfg.color !== undefined) node.style.color = cfg.color;
  if (cfg.borderColor !== undefined) node.style.borderColor = cfg.borderColor;
  if (cfg.borderTopColor !== undefined) node.style.borderTopColor = cfg.borderTopColor;
  if (cfg.borderRadius !== undefined) node.style.borderRadius = cfg.borderRadius;
  // 用 !== undefined 而不是真值判断：清空 --nts-chat-blur 时要能把上一帧的
  // backdrop-filter 撤掉，否则预览里毛玻璃永远留着，看着像清空没生效。
  if (cfg.blur !== undefined) {
    node.style.backdropFilter = cfg.blur || '';
    node.style.webkitBackdropFilter = cfg.blur || '';
  }
}

function styleBubble(node, cfg) {
  if (!node) return;
  node.style.backgroundColor = cfg.background;
  node.style.color = cfg.color;
  node.style.borderColor = cfg.borderColor;
  node.style.borderStyle = 'solid';
  node.style.borderWidth = '1px';
  node.style.borderRadius = cfg.radius || '12px';
  node.style.alignSelf = cfg.align;
  // 气泡的 backdrop 模糊：聊天背景虚化开关（--nts-bubble-veil）按 0–1 乘子
  // 缩放半径。必须无条件写（哪怕空串），否则关掉开关后上一帧的模糊会留在
  // 预览里，看着像开关没生效。
  if (cfg.blur !== undefined) {
    node.style.backdropFilter = cfg.blur || '';
    node.style.webkitBackdropFilter = cfg.blur || '';
  }
}

/* 把 RGBA 数组按 0–1 乘子缩放 alpha（预览里的"白纱"）。 */
function veilSheet(rgba, veil) {
  return toRgba(rgba[0], rgba[1], rgba[2], rgba[3] * veil);
}

/* 把一个 CSS 颜色按 0–1 乘子缩放 alpha；解析不了就原样返回。 */
function veilTint(color, veil) {
  var c = parseColor(color);
  if (!c) return color;
  var a = (c.a === undefined ? 1 : c.a) * veil;
  return toRgba(c.r, c.g, c.b, a);
}

/* ============================================================================
 * 9. 调色板 dump / 元信息
 * ==========================================================================*/

function renderDump() {
  var payload = {
    name: $('theme-name') ? $('theme-name').value : undefined,
    enabled: $('theme-enabled').checked,
    vars: effectiveVars('light'),
    dark_vars: effectiveVars('dark')
  };
  var pending = Object.keys(state.edited.light).length + Object.keys(state.edited.dark).length +
    Object.keys(state.cleared.light).length + Object.keys(state.cleared.dark).length;
  // 这里必须是纯 JSON：旧实现把 "// ↑ 含 N 项未应用的改动" 拼在 JSON 末尾，
  // 与右侧 dump 说明（effectiveVars，含未应用改动）不一致，复制出去也不是合法
  // JSON。未应用提示改放 #dump-foot —— 它在 #dump 之外，复制永远拿到合法 JSON。
  $('dump').textContent = JSON.stringify(payload, null, 2);

  var foot = $('dump-foot');
  if (foot) {
    var saved = paletteCounts(state.palette);
    foot.textContent = '已保存：亮色 ' + saved.light + ' 项 / 暗色 ' + saved.dark + ' 项' +
      (pending ? '；另有 ' + pending + ' 项改动尚未应用（上面的 JSON 不含它们）。' : '；没有未应用的改动。');
  }
}

/** 某模式「生效中」的变量：服务器已保存的值叠加本地未应用的改动。
 *
 * 注意不能直接用 collect(mode)：那只包含本次会话里改过/清空过的键，读回一个
 * 已保存的调色板时会渲染成空对象 —— 面板会声称「当前调色板 vars: {}」，
 * 与磁盘上真实的 theme.json 不符，极为误导。
 */
function effectiveVars(mode) {
  var out = {};
  var saved = state.palette
    ? (mode === 'dark' ? state.palette.dark_vars : state.palette.vars)
    : null;
  if (saved) Object.keys(saved).forEach(function (k) { out[k] = saved[k]; });
  Object.keys(state.edited[mode]).forEach(function (k) { out[k] = state.edited[mode][k]; });
  Object.keys(state.cleared[mode]).forEach(function (k) { delete out[k]; });
  return out;
}

function collect(mode) {
  var out = {};
  var edited = state.edited[mode];
  var cleared = state.cleared[mode];
  Object.keys(edited).forEach(function (k) { out[k] = edited[k]; });
  Object.keys(cleared).forEach(function (k) { out[k] = ''; });
  return out;
}

function renderMeta() {
  var p = state.palette;
  if (!p) return;
  // 基线必须在每次读回调色板时刷新：applyTheme 靠它判断名称/启用是否真的变了。
  state.metaName = p.name || '';
  state.metaEnabled = p.enabled !== false;
  // theme.json 不再有 version 字段（0.1.5 起）：面板也不显示版本计数，
  // 只留主题名与「最后更新时间」两枚 pill。
  $('meta-name').textContent = p.name || '默认';
  var when = p.updated_at ? String(p.updated_at).replace('T', ' ').slice(0, 19) : '—';
  $('meta-updated').textContent = when;
  if (document.getElementById('theme-name') && document.activeElement !== $('theme-name')) {
    $('theme-name').value = p.name || '';
  }
  $('theme-enabled').checked = p.enabled !== false;
}

function updateButtons() {
  var n = dirtyCount();
  var applyBtn = $('btn-apply');
  applyBtn.textContent = n ? '应用（' + n + ' 项改动）' : '应用';
  applyBtn.disabled = state.busy;
  applyBtn.dataset.busy = state.busy ? 'true' : 'false';
  ['btn-reset', 'btn-export', 'btn-import', 'btn-reload', 'btn-revert-mode'].forEach(function (id) {
    var node = $(id);
    if (node) node.disabled = state.busy;
  });
}

/* ============================================================================
 * 10. 动作
 * ==========================================================================*/

function buildArgs(mode) {
  return collect(mode);
}

/** 调色板里两组各有多少项（0 是常见且值得说出来的状态）。 */
function paletteCounts(p) {
  var l = p && p.vars && typeof p.vars === 'object' ? Object.keys(p.vars).length : 0;
  var d = p && p.dark_vars && typeof p.dark_vars === 'object' ? Object.keys(p.dark_vars).length : 0;
  return { light: l, dark: d };
}

/**
 * 只改了一组时的提醒。亮/暗两组是各管各的（THEME_CONTRACT §3.0），
 * 所以「只配了亮色、应用却在暗色模式」= 零效果 —— 这是最容易误判成
 * 「插件坏了」的用法，必须在提示里点出来。
 */
function modeHint(nLight, nDark) {
  if (nLight && !nDark) {
    return '\n注意：本次只改了「亮色」组 —— 应用若正处在暗色模式，外观不会变（两组各管各的）。';
  }
  if (nDark && !nLight) {
    return '\n注意：本次只改了「暗色」组 —— 应用若正处在亮色模式，外观不会变（两组各管各的）。';
  }
  return '';
}

/** 从磁盘读回调色板时的中性文案：不是「本次只改了」，而是「当前只有」。
 * 旧实现直接用 modeHint，刷新/回读时会误报「本次只改了亮色组」。 */
function savedModeHint(nLight, nDark) {
  if (nLight && !nDark) {
    return '\n当前只有「亮色」组有自定义项（暗色模式仍是原生外观）。';
  }
  if (nDark && !nLight) {
    return '\n当前只有「暗色」组有自定义项（亮色模式仍是原生外观）。';
  }
  return '';
}

/**
 * 编辑器底部那行常驻说明：它要回答「为什么我什么都没看到」这个最常见的问题，
 * 所以把「空 = 原生」和「亮暗两组各管各的」直接写在这里，而不是藏在 README。
 */
function renderPaletteHint() {
  var node = $('empty-hint');
  if (!node) return;
  if (!state.palette) {
    node.textContent = '尚未读取到调色板；面板仍可编辑，点「应用」会重试读取。';
    return;
  }
  var c = paletteCounts(state.palette);
  if (!c.light && !c.dark) {
    node.textContent = '当前调色板为空：所有组件都使用 N.E.K.O 原生外观。任意一行填值并应用，即刻生效。';
    return;
  }
  node.textContent = '已保存 ' + (c.light + c.dark) + ' 项（亮色 ' + c.light + ' / 暗色 ' + c.dark +
    '）。留空的行保持原生外观；两组各管各的，只配一组时另一模式不会变。';
}

/** 从后端 rejected 文案里抠出被拒的变量名（后端文案带 '--nts-xxx'）。 */
function rejectedKeysOf(rejected) {
  var keys = {};
  (rejected || []).forEach(function (msg) {
    var found = String(msg).match(/--nts-[a-z0-9-]+/g);
    if (!found) return;
    found.forEach(function (k) { keys[k] = true; });
  });
  return keys;
}

/**
 * 把被拒绝的提交值放回编辑态。后端只拒绝单条，合法部分已落盘，所以这里
 * 不能清空整组改动，否则用户只能凭记忆重新输入被拒的那个值。
 * @returns {number} 恢复的条目数
 */
function restoreRejected(rejected, sentLight, sentDark) {
  var keys = rejectedKeysOf(rejected);
  var restored = 0;
  function restoreBag(sent, edited, cleared) {
    Object.keys(sent).forEach(function (k) {
      if (!keys[k]) return;
      if (sent[k] === '') cleared[k] = true;
      else edited[k] = sent[k];
      restored += 1;
    });
  }
  restoreBag(sentLight, state.edited.light, state.cleared.light);
  restoreBag(sentDark, state.edited.dark, state.cleared.dark);
  if (restored) { syncAll(); applyFilters(); }
  return restored;
}

async function applyTheme() {
  if (state.busy) return;

  // 红框行必须先解决：非法输入时 edited 里留的是「上一个合法值」，直接应用会
  // 把它提交上去并显示成功，用户会以为刚敲的非法值生效了。这里明确阻止。
  if (invalidRowCount()) {
    var nBad = invalidRowCount();
    showNotice('warn', '有 ' + nBad + ' 行输入不合法（红框），已阻止应用。\n' +
      '请把红框里的值改成合法值，或点该行「清空」。');
    showToast('有非法输入，未应用', 'error');
    setStatus('有非法输入，未应用', 'warn');
    return;
  }

  var lightVars = buildArgs('light');
  var darkVars = buildArgs('dark');
  var nLight = Object.keys(lightVars).length;
  var nDark = Object.keys(darkVars).length;
  var enabled = $('theme-enabled').checked;
  // 用 renderMeta 写入的「已保存基线」比较，而不是 !!state.palette：
  // 首次 get_theme 失败（palette=null）时旧实现一律判为没改，只改名称或启用
  // 开关永远提示「没有可应用的改动」，改动根本提交不出去。
  var enabledChanged = state.metaEnabled !== enabled;
  var nameInput = $('theme-name');
  var name = nameInput ? nameInput.value.trim() : '';
  // 只改主题名也是一次有效改动：漏掉它会让 name 永远存不进去（实测点了应用毫无反应）。
  var nameChanged = name !== (state.metaName || '');

  // 没有任何改动时不要假装成功：否则「点了应用但什么都没发生」会被当成插件故障。
  // 提示语写成诊断信息：编辑是逐键实时记录（oninput → markEdited），不需要失焦。
  if (!nLight && !nDark && !enabledChanged && !nameChanged) {
    showNotice('warn', '没有可应用的改动（当前 0 项变量改动，名称/启用未变，也没有红框非法输入）。\n' +
      '改值会在输入时立即记入面板，不必等控件失焦；如果确实改过，可能是刚才用「还原本组」撤销了。');
    showToast('没有改动可应用');
    setStatus('没有改动可应用', 'warn');
    return;
  }

  var args = {
    vars: lightVars,
    dark_vars: darkVars,
    enabled: enabled
  };
  // 名称清空按默认名提交：与后端「空串/纯空白 = 恢复默认名」一致，
  // DEFAULT_THEME_NAME 与后端常量、placeholder 一致。
  if (nameChanged) args.name = name || DEFAULT_THEME_NAME;

  setBusy(true, '正在应用…');
  try {
    var result = await callPlugin('apply_theme', args);
    var rejected = result && result.rejected;
    state.edited = { light: {}, dark: {} };
    state.cleared = { light: {}, dark: {} };
    markAllRowsValid();
    // 写入成功后必须回读，且要检查返回值：silent 失败被吞时面板还停在旧值，
    // 文案却显示「已应用」—— 用户看到的和磁盘不一致。
    var reloaded = await reloadPalette({ silent: true });
    if (!reloaded) {
      // 回读失败时用提交值更新基线：否则下次比较基线仍是旧值，
      // 会误判出「又有改动」，或反过来把真实改动判成没改。
      if (nameChanged) state.metaName = name || DEFAULT_THEME_NAME;
      state.metaEnabled = enabled;
    }
    // 被拒条目留在面板上，让用户就地修正（合法部分后端已落盘）
    var restored = rejected && rejected.length ? restoreRejected(rejected, lightVars, darkVars) : 0;
    // 只把真正发生的变化写进文案，避免「0 项」和「主题名已改」被漏报。
    var parts = [];
    if (nLight) parts.push('亮色 ' + nLight + ' 项');
    if (nDark) parts.push('暗色 ' + nDark + ' 项');
    if (enabledChanged) parts.push(enabled ? '已启用主题' : '已停用主题');
    if (nameChanged) parts.push('主题名「' + (name || DEFAULT_THEME_NAME) + '」');
    var counts = parts.length ? parts.join(' / ') : '无变量改动';
    var readbackNote = reloaded ? '' :
      '\n已写入，但回读失败，面板显示可能不是最新值，请点「重新读取」。';
    if (rejected && rejected.length) {
      showNotice('warn', '已应用（' + counts + '），但后端拒绝了 ' + rejected.length +
        ' 条，已把它们的原值放回面板便于就地修正：\n' + rejected.join('\n') + readbackNote);
      showToast('已应用（' + rejected.length + ' 条被拒绝' + (restored ? '，已回填' : '') + '）');
    } else {
      showNotice(reloaded ? 'ok' : 'warn', '已应用并写入 theme.json：' + counts +
        modeHint(nLight, nDark) + readbackNote);
      showToast('已应用 ' + counts, 'ok');
    }
    setStatus('已应用 ' + counts + (restored ? '（' + restored + ' 条待修正）' : '') +
      (reloaded ? '' : '（回读失败）'),
      reloaded ? 'ok' : 'warn');
  } catch (error) {
    showNotice('error', '应用失败：' + pluginErrorMessage(error));
    showToast('应用失败', 'error');
    setStatus('应用失败', 'error');
  } finally {
    setBusy(false);
  }
}

async function resetTheme() {
  if (state.busy) return;
  if (!window.confirm('确定恢复内置默认主题？当前所有自定义颜色都会被清除。')) return;
  setBusy(true, '正在重置…');
  try {
    var result = await callPlugin('reset_theme', {});
    state.edited = { light: {}, dark: {} };
    state.cleared = { light: {}, dark: {} };
    markAllRowsValid();
    clearRgbMemory();
    var reloaded = await reloadPalette({ silent: true });
    if (reloaded) {
      showNotice('ok', '已恢复默认主题。');
    } else {
      // 重置已落盘，但面板没能回读：提示重新读取，而不是假装一切最新。
      showNotice('warn', '已恢复默认主题。\n回读失败，面板显示可能不是最新值，请点「重新读取」。');
    }
    showToast('已重置', 'ok');
    setStatus('已重置' + (reloaded ? '' : '（回读失败）'), reloaded ? 'ok' : 'warn');
  } catch (error) {
    showNotice('error', '重置失败：' + pluginErrorMessage(error));
    showToast('重置失败', 'error');
    setStatus('重置失败', 'error');
  } finally {
    setBusy(false);
  }
}

/**
 * 让插件进程直接把文件写到磁盘。
 * 面板跑在宿主的 sandbox iframe 里（sandbox 串里没有 allow-downloads），
 * Blob + <a download> 会被 Chromium 静默丢弃 —— 只能由后端写盘。
 */
async function saveThemeFile(args) {
  var result = await callPlugin('export_to_file', args);
  if (!result || !result.path) throw new Error('后端没有返回保存路径');
  return result;
}

function savedHint(result) {
  var kb = Math.round((result.bytes || 0) / 1024);
  return '文件已保存到：' + result.path +
    '\n（' + kb + ' KB' + (result.images ? '，含 ' + result.images + ' 张背景图' : '') + '）';
}

async function exportTheme() {
  if (state.busy) return;
  // 后端 export_theme 返回的是磁盘上已保存的 theme.json，不含面板里未应用的改动。
  // 与右侧 dump（effectiveVars，含未应用改动）不一致，所以先明确告知再导出。
  var pending = dirtyCount();
  if (pending && !window.confirm('有 ' + pending + ' 项未应用的改动。\n' +
    '导出的 JSON 来自磁盘上已保存的 theme.json（不含这些未应用改动）。继续导出？')) {
    return;
  }
  setBusy(true, '正在导出…');
  try {
    var result = await callPlugin('export_theme', {});
    var hint = pending
      ? '下面是已保存到 theme.json 的调色板 JSON（不含 ' + pending + ' 项未应用改动），可复制保存或分享。'
      : '下面是当前调色板的 JSON 文本，可复制保存或分享。';
    // 顺手落磁盘：宿主的 iframe sandbox 没有 allow-downloads，浏览器下载会被丢弃。
    try {
      var savedJson = await saveThemeFile({ kind: 'json', target: 'desktop' });
      hint = savedHint(savedJson) + '\n\n' + hint;
      setStatus(pending ? '已导出并保存（不含未应用改动）' : '已导出并保存到桌面', 'ok');
    } catch (saveError) {
      hint = '保存文件失败（' + pluginErrorMessage(saveError) + '），下面是 JSON 文本，可手动复制。\n\n' + hint;
      setStatus('已导出（未写出文件）', 'ok');
    }
    openModal('export', '导出主题', hint, result.payload || '');
  } catch (error) {
    showNotice('error', '导出失败：' + pluginErrorMessage(error));
    showToast('导出失败', 'error');
    setStatus('导出失败', 'error');
  } finally {
    setBusy(false);
  }
}

// 与 plugin/__init__.py 的 IMPORT_MAX_CHARS 保持一致。宿主的 input_schema 会在
// entry 被调用之前就按 maxLength 拒绝超长输入，并把错误包成 INTERNAL，用户看到的
// 是一条看不懂的内部报错 —— 所以这里先拦一次，给出人话提示。
var IMPORT_MAX_CHARS = 262144;

function openImport() {
  openModal('import', '导入主题', '粘贴调色板 JSON 文本。导入为整体替换；非法条目会被后端丢弃。', '');
}

async function doImport() {
  var text = $('modal-text').value.trim();
  if (!text) { showToast('请先粘贴内容'); return; }
  if (text.length > IMPORT_MAX_CHARS) {
    var tooLong = '导入内容过长（' + text.length + ' 字符，上限 ' + IMPORT_MAX_CHARS +
      ' 字符）。请删掉不必要的内容后重试。';
    showNotice('error', tooLong);
    showToast('导入失败', 'error');
    setStatus('导入失败：内容过长', 'error');
    openModal('import', '导入主题', tooLong + '\n粘贴内容已保留，可修改后重试。', text);
    return;
  }
  closeModal();
  setBusy(true, '正在导入…');
  try {
    var result = await callPlugin('import_theme', { payload: text });
    state.edited = { light: {}, dark: {} };
    state.cleared = { light: {}, dark: {} };
    markAllRowsValid();
    clearRgbMemory();
    var reloaded = await reloadPalette({ silent: true });
    var readbackNote = reloaded ? '' :
      '\n已写入，但回读失败，面板显示可能不是最新值，请点「重新读取」。';
    var rejected = result && result.rejected;
    if (rejected && rejected.length) {
      showNotice('warn', '已导入，但后端拒绝了 ' + rejected.length + ' 条：\n' + rejected.join('\n') + readbackNote);
      showToast('已导入（部分条目被拒绝）', 'ok');
      setStatus('已导入（' + rejected.length + ' 条被拒绝' + (reloaded ? '' : '，回读失败') + '）', 'warn');
    } else {
      showNotice(reloaded ? 'ok' : 'warn', '已导入并写入 theme.json。' + readbackNote);
      showToast('已导入', 'ok');
      setStatus('已导入' + (reloaded ? '' : '（回读失败）'), reloaded ? 'ok' : 'warn');
    }
  } catch (error) {
    showNotice('error', '导入失败：' + pluginErrorMessage(error));
    showToast('导入失败', 'error');
    setStatus('导入失败', 'error');
    // 失败时调色板没变，把用户粘贴的文本放回弹窗，避免「内容被吞、只能重新粘贴」。
    openModal('import', '导入主题',
      '导入失败：' + pluginErrorMessage(error) + '\n粘贴内容已保留，可修改后重试。', text);
  } finally {
    setBusy(false);
  }
}

/* ============================================================================
 * 10b. 主题仓库（保存 / 切换 / 分享 zip / 导入 zip）
 * ==========================================================================*/

/** 3 秒内二次点击才真正删除的行内确认状态（不用 window.confirm：
 *  无头/自动化环境下 confirm 会阻塞渲染进程，整个面板假死）。 */
var pendingDelete = { id: '', at: 0 };
var LIB_CONFIRM_MS = 3000;

/** base64 → Uint8Array。atob 对非法字符抛异常，调用方自己兜。 */
function base64ToBytes(base64) {
  var bin = atob(base64);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

/** 触发一次浏览器下载（Blob + 临时 <a download>）。 */
function downloadBlob(bytes, filename, mime) {
  var blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // 立刻 revoke 会让部分 Chromium 版本取消下载，延后一拍。
  setTimeout(function () {
    try { document.body.removeChild(a); } catch (e) { /* 已被移除 */ }
    URL.revokeObjectURL(url);
  }, 1000);
}

/** 仓库条目的一行（名字用 textContent，绝不拼 HTML）。 */
function buildLibraryItem(item) {
  var name = String(item.name || item.id || '未命名');
  var meta = [];
  // 内置主题的 saved_at 是「内置」，不要再当时间显示。
  if (item.builtin) meta.push('内置');
  else meta.push(String(item.saved_at || '').replace('T', ' ').slice(0, 16) || '未记录时间');
  meta.push('亮 ' + (item.light || 0) + ' / 暗 ' + (item.dark || 0));
  if (item.has_image) meta.push('含背景图');

  var main = el('div', { class: 'lib-main' }, [
    el('span', { class: 'lib-name-text', text: name, title: name }),
    el('span', { class: 'lib-meta', text: meta.join(' · ') })
  ]);

  var applyBtn = el('button', {
    type: 'button', class: 'btn btn-mini', 'data-act': 'apply', text: '应用',
    'aria-label': '应用主题 ' + name
  });
  var exportBtn = el('button', {
    type: 'button', class: 'btn btn-mini', 'data-act': 'export', text: '分享',
    title: '导出成 zip（含背景图片）', 'aria-label': '分享主题 ' + name
  });
  // 内置主题删不掉（后端也会拒绝），直接不渲染删除按钮。
  var deleteBtn = item.builtin ? null : el('button', {
    type: 'button', class: 'btn btn-mini', 'data-act': 'delete', text: '删除',
    'aria-label': '删除主题 ' + name
  });

  applyBtn.addEventListener('click', function () { applyLibraryItem(item, applyBtn); });
  exportBtn.addEventListener('click', function () { exportLibraryItem(item, exportBtn); });
  if (deleteBtn) {
    deleteBtn.addEventListener('click', function () { deleteLibraryItem(item, deleteBtn); });
  }

  var libBtns = [applyBtn, exportBtn];
  if (deleteBtn) libBtns.push(deleteBtn);
  var row = el('li', { class: 'lib-item' }, [
    main,
    el('div', { class: 'lib-btns' }, libBtns)
  ]);
  row.setAttribute('data-id', String(item.id || ''));
  return row;
}

async function refreshLibrary() {
  var list = $('lib-list');
  var empty = $('lib-empty');
  if (!list) return null;
  try {
    var result = await callPlugin('list_themes', {});
    // 后端返回 {count, themes:[...]}（早期版本写的是 items，字段名对不上时仓库永远空白）。
    var items = result && result.themes instanceof Array ? result.themes
      : (result && result.items instanceof Array ? result.items : []);
    list.innerHTML = '';
    items.forEach(function (item) { list.appendChild(buildLibraryItem(item)); });
    if (empty) empty.hidden = items.length > 0;
    return items;
  } catch (error) {
    // 仓库读不到不该挡住编辑器：只提示，不抛。
    if (empty) {
      empty.hidden = false;
      empty.textContent = '仓库读取失败：' + pluginErrorMessage(error);
    }
    return null;
  }
}

async function saveLibraryTheme() {
  if (state.busy) return;
  var input = $('lib-name');
  var name = input ? input.value.trim() : '';
  setBusy(true, '正在保存到仓库…');
  try {
    var args = {};
    if (name) args.name = name;
    var result = await callPlugin('save_theme', args);
    if (input) input.value = '';
    await refreshLibrary();
    var savedName = (result && result.theme && result.theme.name)
      || (result && result.name) || name || '当前主题';
    showToast('已保存「' + savedName + '」到仓库', 'ok');
    setStatus('已保存到仓库', 'ok');
  } catch (error) {
    showNotice('error', '保存到仓库失败：' + pluginErrorMessage(error));
    showToast('保存失败', 'error');
    setStatus('保存到仓库失败', 'error');
  } finally {
    setBusy(false);
  }
}

async function applyLibraryItem(item, button) {
  if (state.busy) return;
  if (button) button.disabled = true;
  setBusy(true, '正在切换主题…');
  try {
    var result = await callPlugin('apply_saved_theme', { id: item.id });
    // 整体替换语义：面板里的未应用改动会失效，必须清干净再回读。
    state.edited = { light: {}, dark: {} };
    state.cleared = { light: {}, dark: {} };
    markAllRowsValid();
    clearRgbMemory();
    var reloaded = await reloadPalette({ silent: true });
    var label = (result && result.theme && result.theme.name)
      || (result && result.name) || item.name || '该主题';
    showNotice(reloaded ? 'ok' : 'warn', '已切换到「' + label + '」' +
      (reloaded ? '' : '\n回读失败，面板显示可能不是最新值，请点「重新读取」。'));
    showToast('已切换到「' + label + '」', 'ok');
    setStatus('已切换主题' + (reloaded ? '' : '（回读失败）'), reloaded ? 'ok' : 'warn');
  } catch (error) {
    showNotice('error', '切换主题失败：' + pluginErrorMessage(error));
    showToast('切换失败', 'error');
    setStatus('切换主题失败', 'error');
  } finally {
    if (button) button.disabled = false;
    setBusy(false);
  }
}

async function exportLibraryItem(item, button) {
  if (state.busy) return;
  if (button) button.disabled = true;
  setBusy(true, '正在打包…');
  try {
    var savedZip = null;
    try {
      savedZip = await saveThemeFile({ kind: 'zip', target: 'desktop', id: item.id });
    } catch (saveError) {
      savedZip = null; // 写盘失败再退回浏览器下载
    }
    if (savedZip) {
      showNotice('info', '分享包已保存到 ' + savedZip.path +
        '\n（' + (savedZip.images ? '含 ' + savedZip.images + ' 张背景图，' : '') +
        Math.round((savedZip.bytes || 0) / 1024) + ' KB）');
      showToast('已保存 ' + savedZip.filename, 'ok');
      setStatus('已保存分享包到桌面', 'ok');
      return;
    }
    var result = await callPlugin('export_theme_archive', { id: item.id });
    var data = result && result.data ? String(result.data) : '';
    if (!data) throw new Error('后端没有返回包内容');
    var bytes = base64ToBytes(data);
    var filename = (result && result.filename) || ((item.name || 'theme') + '.zip');
    downloadBlob(bytes, filename, 'application/zip');
    var images = result && typeof result.images === 'number' ? result.images : 0;
    showToast('已导出 ' + filename + (images ? '（含 ' + images + ' 张图）' : ''), 'ok');
    setStatus('已导出分享包', 'ok');
  } catch (error) {
    showNotice('error', '导出分享包失败：' + pluginErrorMessage(error));
    showToast('导出失败', 'error');
    setStatus('导出分享包失败', 'error');
  } finally {
    if (button) button.disabled = false;
    setBusy(false);
  }
}

async function deleteLibraryItem(item, button) {
  if (state.busy) return;
  var now = Date.now();
  var armed = pendingDelete.id === item.id && now - pendingDelete.at < LIB_CONFIRM_MS;
  if (!armed) {
    pendingDelete = { id: item.id, at: now };
    if (button) {
      button.classList.add('is-confirm');
      button.textContent = '确认删除';
    }
    showToast('再点一次「确认删除」才会删掉');
    setTimeout(function () {
      // 超时自动解除，避免按钮永远停在确认态。
      if (button) {
        button.classList.remove('is-confirm');
        button.textContent = '删除';
      }
      if (pendingDelete.id === item.id) pendingDelete = { id: '', at: 0 };
    }, LIB_CONFIRM_MS);
    return;
  }
  pendingDelete = { id: '', at: 0 };
  if (button) button.disabled = true;
  setBusy(true, '正在删除…');
  try {
    await callPlugin('delete_theme', { id: item.id });
    await refreshLibrary();
    showToast('已删除', 'ok');
    setStatus('已删除仓库条目', 'ok');
  } catch (error) {
    showNotice('error', '删除失败：' + pluginErrorMessage(error));
    showToast('删除失败', 'error');
    setStatus('删除失败', 'error');
  } finally {
    setBusy(false);
  }
}

/** 读本地 zip / json 文件并导入仓库（只入仓库，不自动应用）。 */
function pickArchiveFile() {
  var fileInput = $('lib-file');
  if (fileInput) fileInput.click();
}

function handleArchiveFile(file, fileInput) {
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function () {
    var raw = String(reader.result || '');
    var comma = raw.indexOf(',');
    var base64 = comma >= 0 ? raw.slice(comma + 1) : '';
    if (fileInput) fileInput.value = '';
    if (!base64) { showToast('读取文件失败', 'error'); return; }
    importArchive(file.name, base64);
  };
  reader.onerror = function () {
    if (fileInput) fileInput.value = '';
    var why = reader.error && reader.error.message ? reader.error.message : file.name;
    showNotice('error', '读取文件失败：' + why);
    showToast('读取文件失败', 'error');
  };
  reader.readAsDataURL(file);
}

async function importArchive(filename, base64) {
  if (state.busy) return;
  setBusy(true, '正在导入分享包…');
  try {
    var result = await callPlugin('import_theme_archive', {
      filename: filename || '',
      data: base64
    });
    await refreshLibrary();
    var label = (result && result.theme && result.theme.name)
      || (result && result.name) || '未命名主题';
    // import_theme_archive 返回 {imported, theme:{...has_image}, source_format, rejected}，
    // 没有顶层 images 计数，只能从 theme.has_image 推断（zip 里的图已落盘并改写引用）。
    var images = (result && result.theme && result.theme.has_image) ? 1 : 0;
    showNotice('ok', '已导入「' + label + '」到仓库' + (images ? '（含 ' + images + ' 张背景图）' : '') +
      '\n它还没有生效 —— 在列表里点「应用」才会切换过去。');
    showToast('已导入到仓库', 'ok');
    setStatus('已导入到仓库', 'ok');
  } catch (error) {
    showNotice('error', '导入分享包失败：' + pluginErrorMessage(error));
    showToast('导入失败', 'error');
    setStatus('导入分享包失败', 'error');
  } finally {
    setBusy(false);
  }
}

function revertMode() {
  var mode = state.mode;
  var n = Object.keys(state.edited[mode]).length + Object.keys(state.cleared[mode]).length;
  if (!n) { showToast('当前' + (mode === 'dark' ? '暗色' : '亮色') + '组没有改动'); return; }
  state.edited[mode] = {};
  state.cleared[mode] = {};
  syncAll();
  showToast('已还原' + (mode === 'dark' ? '暗色' : '亮色') + '组改动', 'ok');
}

async function reloadPalette(options) {
  var silent = options && options.silent;
  setLoading(true);
  try {
    var palette = await callPlugin('get_theme', {});
    state.palette = palette;
    renderMeta();
    renderPaletteHint();
    syncAll();
    applyFilters();
    var c = paletteCounts(palette);
    if (!silent) {
      showNotice('ok', '已读取当前主题：亮色 ' + c.light +
        ' 项 / 暗色 ' + c.dark + ' 项' + savedModeHint(c.light, c.dark));
      // 状态栏常驻显示两条腿各有多少项，避免「只配了一组」被忽略。
      setStatus('已读取 · 亮色 ' + c.light + ' / 暗色 ' + c.dark, 'ok');
    }
    return palette;
  } catch (error) {
    if (!silent) {
      showNotice('error', '读取失败：' + pluginErrorMessage(error) + '\n（后端插件可能未启动；面板仍可编辑，点击「应用」会重试。）');
      setStatus('读取失败', 'error');
    }
    // 读取失败也不能让面板变成空白：用当前编辑状态继续渲染。
    renderPaletteHint();
    syncAll();
    return null;
  } finally {
    setLoading(false);
  }
}

/** busy 期间锁住行内控件：否则飞行中的编辑会在成功后随 state.edited 清空而静默丢失。 */
function setRowControlsDisabled(busy) {
  Object.keys(rowsByKey).forEach(function (key) {
    var ref = rowsByKey[key];
    ['hexInput', 'colorInput', 'alpha', 'textInput', 'clearBtn'].forEach(function (name) {
      if (ref[name]) ref[name].disabled = !!busy;
    });
    // 解锁时不能把 alpha 一律启用：transparent / inherit / 空 的行必须继续置灰，
    // 否则应用一次之后滑块又能拖出纯黑半透明（旧实现只在 syncRow 里设 disabled，
    // 被这里一次性覆盖掉）。但若有 RGB 记忆（拖过颜色/选过色），transparent
    // 也要保持可用 —— 拖动会沿用记忆里的颜色，见 lastRgbByKey。
    if (!busy && ref.alpha) {
      var parsed = parseColor(displayValue(key));
      var transparent = !!parsed && parsed.a === 0;
      ref.alpha.disabled = !parsed || (transparent && !lastRgbByKey[key]);
    }
  });
}

function setBusy(busy, message) {
  state.busy = busy;
  updateButtons();
  setRowControlsDisabled(busy);
  if (busy && message) setStatus(message, 'busy');
}

/* -------------------------------------------------------------------------- *
 * 10e. 安装自检（health card）
 *
 * 为什么需要这一块：主题生效必须由插件自己把 loader 两件套与两行标签写进
 * N.E.K.O 的安装目录（宿主没有注入 API）。这一步在受保护的安装目录
 * （Program Files）、非 Windows 的 .app 包里会失败，而失败原先只写日志 ——
 * 用户看到的现象就是「装上了但没效果」，无从下手。这里把结果摊到面板上，
 * 并提供一键修复与排查说明。
 * -------------------------------------------------------------------------- */

var HELP_TOPICS = [
  {
    title: '主题装上了但界面完全没变',
    body: '按顺序试：①点这张卡片上的「一键修复」；②彻底关掉 N.E.K.O 再重开（已打开的窗口不会自己重载）；'
      + '③确认真的选过颜色并点了「应用」—— 出厂调色板是空的，空主题就是完全原生外观。'
  },
  {
    title: 'Windows：N.E.K.O 装在 Program Files 里',
    body: '插件进程没有管理员权限，就写不进 resources\\bin\\static 与 templates。'
      + '解决：把 N.E.K.O 换到不需要管理员的目录（例如 %LOCALAPPDATA%\\Programs），或右键以管理员身份运行一次 N.E.K.O。'
  },
  {
    title: 'macOS：N.E.K.O 在 .app 包里',
    body: 'macOS 的 .app 包受签名与系统保护，普通权限改不了内部文件；本插件目前只支持 Windows。'
  },
  {
    title: '其它打包版本 / Linux',
    body: '只要目标机器上是「Electron 外壳 + resources/bin 下的 Python 后端」的结构、且安装目录对当前用户可写，逻辑就能跑；'
      + 'AppImage、只读挂载、沙箱商店分发不支持。'
  },
  {
    title: '为什么每次改完都要点「应用」',
    body: '面板上的值只是草稿，点「应用」才写进 theme.json；应用窗口每 1.5 秒读一次它。'
      + '主题仓库里的条目同理，点「应用」才切换过去。'
  },
  {
    title: '亮色 / 暗色是两套独立配色',
    body: '面板顶部的「亮色 / 暗色」互相独立。只改了暗色组时，系统处在亮色模式下当然看不到变化。'
  }
];

function openHelpModal() {
  var lines = [];
  for (var i = 0; i < HELP_TOPICS.length; i += 1) {
    lines.push((i + 1) + '. ' + HELP_TOPICS[i].title);
    lines.push('   ' + HELP_TOPICS[i].body);
    lines.push('');
  }
  openModal('help', '为什么没生效？',
    '这是主题工坊最常见的问题清单。改完关掉 N.E.K.O 再重开，通常就能看到变化。',
    lines.join('\n'));
}

function healthItem(key, value, level) {
  return { key: key, value: value, level: level || 'ok' };
}

function renderHealth(diag) {
  var stateNode = $('health-state');
  var listNode = $('health-list');
  if (!stateNode || !listNode) return;
  while (listNode.firstChild) listNode.removeChild(listNode.firstChild);

  var items = [];
  var level = 'ok';

  if (!diag || typeof diag !== 'object') {
    stateNode.textContent = '检查失败：拿不到安装状态';
    stateNode.className = 'health-line is-bad';
    return;
  }

  if (diag.disabled) {
    level = 'bad';
    items.push(healthItem('状态', '检测到卸载标记，自动安装被停用', 'bad'));
  } else if (diag.ok) {
    items.push(healthItem('应用侧补丁', '已就位', 'ok'));
  } else {
    level = 'bad';
    items.push(healthItem('应用侧补丁', '没有装好 —— 这就是看不到效果的原因', 'bad'));
  }

  if (diag.app_root) {
    items.push(healthItem('安装目录', String(diag.app_root), 'ok'));
  } else {
    level = 'bad';
    items.push(healthItem('安装目录', '没找到（resources/bin/templates 不在预期位置）', 'bad'));
    var tried = (diag.search_paths || []).slice(0, 4);
    for (var t = 0; t < tried.length; t += 1) {
      items.push(healthItem('试过', String(tried[t]), 'bad'));
    }
  }

  if (diag.platform_note) {
    if (level === 'ok') level = 'warn';
    items.push(healthItem('平台', String(diag.platform_note), 'warn'));
  }

  var wrote = (diag.assets_written || []).length;
  var same = (diag.assets_unchanged || []).length;
  var failed = diag.assets_failed || [];
  if (failed.length) {
    level = 'bad';
    items.push(healthItem('资源写入', '失败：' + failed.join('、'), 'bad'));
  } else if (wrote + same > 0) {
    items.push(healthItem('样式与脚本', '就绪（本次更新 ' + wrote + ' 个，已是最新 ' + same + ' 个）', 'ok'));
  }

  var patched = (diag.templates_patched || []).length;
  var untouched = (diag.templates_unchanged || []).length;
  var skipped = (diag.templates_skipped || []).length;
  var missing = diag.missing_required || [];
  if (missing.length) {
    level = 'bad';
    items.push(healthItem('页面注入', '缺少必备页面：' + missing.join('、'), 'bad'));
  } else if (patched + untouched > 0) {
    items.push(healthItem('页面注入', '已注入 ' + (patched + untouched) + ' 个页面'
      + (patched ? '（本次改写 ' + patched + ' 个）' : '')
      + (skipped ? '，跳过 ' + skipped + ' 个' : ''), 'ok'));
  }

  if (diag.autostart) {
    var auto = String(diag.autostart);
    var autoOk = auto === 'scheduled' || auto === 'ok' || auto === 'done';
    if (!autoOk && level === 'ok') level = 'warn';
    items.push(healthItem('开机自启', auto, autoOk ? 'ok' : 'warn'));
  }

  var warnings = diag.warnings || [];
  for (var w = 0; w < warnings.length && w < 5; w += 1) {
    if (level === 'ok') level = 'warn';
    items.push(healthItem('提示', String(warnings[w]), 'warn'));
  }

  for (var i = 0; i < items.length; i += 1) {
    var li = el('li', { class: items[i].level === 'ok' ? '' : 'is-' + items[i].level });
    li.appendChild(el('span', { class: 'hk', text: items[i].key + '：' }));
    li.appendChild(el('span', { class: 'hv', text: items[i].value }));
    listNode.appendChild(li);
  }

  if (level === 'ok') {
    stateNode.textContent = '一切正常：主题已经装进 N.E.K.O';
  } else if (level === 'warn') {
    stateNode.textContent = '基本可用，但有几处需要注意';
  } else {
    stateNode.textContent = '没装好：主题不会生效';
  }
  stateNode.className = 'health-line is-' + level;
}

function refreshHealth(options) {
  var opts = options || {};
  return callPlugin('repair_app', {})
    .then(function (result) {
      state.health = result || {};
      renderHealth(state.health);
      if (opts.toast) {
        showToast(state.health.ok ? '安装状态正常' : '安装状态异常，已列在上面',
          state.health.ok ? 'ok' : 'error');
      }
      return state.health;
    })
    .catch(function (error) {
      state.health = null;
      var stateNode = $('health-state');
      if (stateNode) {
        stateNode.textContent = '检查失败：' + pluginErrorMessage(error);
        stateNode.className = 'health-line is-bad';
      }
      if (opts.toast) showToast('检查失败', 'error');
      return null;
    });
}

async function runHealthRepair() {
  var button = $('btn-health-repair');
  if (state.busy) return;
  if (button) button.disabled = true;
  setStatus('正在重新安装主题…', 'busy');
  try {
    var result = await callPlugin('repair_app', {});
    state.health = result || {};
    renderHealth(state.health);
    if (state.health && state.health.ok) {
      showNotice('info', '修复完成：主题已重新装进 N.E.K.O。\n'
        + '如果界面还是没变化，请关掉聊天窗口再打开，或重启 N.E.K.O。');
      setStatus('修复完成', 'ok');
    } else {
      var reason = (state.health && (state.health.assets_failed || []).length)
        ? '写不进安装目录（多半是权限问题）'
        : '安装目录不完整';
      showNotice('error', '修复没成功：' + reason + '。\n点「为什么没生效？」查看解决办法。');
      setStatus('修复失败', 'error');
    }
  } catch (error) {
    showNotice('error', '修复失败：' + pluginErrorMessage(error));
    setStatus('修复失败', 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

/* ============================================================================
 * 11. 弹窗
 * ==========================================================================*/

function openModal(mode, title, hint, text) {
  state.modalMode = mode;
  // 记住打开弹窗前焦点在哪，关闭后还回去（否则键盘用户会掉回页面顶部）
  state.modalReturnFocus = document.activeElement;
  $('modal-title').textContent = title;
  $('modal-hint').textContent = hint;
  var area = $('modal-text');
  area.value = text || '';
  area.readOnly = mode === 'export';
  if (mode === 'export') area.select();
  $('modal-ok').textContent = mode === 'export' ? '复制并关闭' : '确定';
  $('modal').hidden = false;
  area.focus();
}

function closeModal() {
  var modal = $('modal');
  if (modal) modal.hidden = true;
  var back = state.modalReturnFocus;
  state.modalReturnFocus = null;
  if (back && typeof back.focus === 'function') {
    try { back.focus(); } catch (e) { /* 元素可能已被替换，忽略 */ }
  }
}

/** 弹窗打开时把 Tab 圈在面板内，避免焦点跑到背后的行编辑器上。 */
function trapModalFocus(event) {
  var panel = $('modal-panel') || $('modal');
  if (!panel) return;
  var nodes = panel.querySelectorAll('button, textarea, input, [tabindex]:not([tabindex="-1"])');
  var list = Array.prototype.filter.call(nodes, function (node) {
    return !node.disabled && node.offsetParent !== null;
  });
  if (list.length < 2) return;
  var first = list[0];
  var last = list[list.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.reject(new Error('clipboard unavailable'));
}

function onModalOk() {
  if (state.modalMode === 'export') {
    var area = $('modal-text');
    area.select();
    copyText(area.value).then(function () {
      showToast('已复制到剪贴板', 'ok');
    }).catch(function () {
      showToast('请手动复制（Ctrl+C）');
    });
    closeModal();
    return;
  }
  doImport();
}

/** 复制调色板 dump（含未应用改动），方便贴 issue / 对比。 */
function copyDump() {
  copyText($('dump').textContent || '').then(function () {
    showToast('调色板 JSON 已复制', 'ok');
  }).catch(function () {
    showToast('复制失败，请手动选择文本');
  });
}

/* ============================================================================
 * 12. 引导
 * ==========================================================================*/

function isTypingTarget(node) {
  if (!node || !node.tagName) return false;
  var tag = node.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || node.isContentEditable === true;
}

/** 搜索结果里第一个可见行的可编辑控件 —— 让键盘用户按回车能直接开始改。 */
function firstVisibleRow() {
  var wrap = document.querySelector('.row-wrap:not([hidden])');
  if (!wrap) return null;
  // 只返回可键入的输入框：色块是 type=color，聚焦它既不能打字、也不会弹出色板
  // （浏览器只在点击时弹），键盘用户按回车会卡在那里。
  return wrap.querySelector('input.hex, input.raw');
}

function wireEvents() {
  $('mode-light').addEventListener('click', function () { setMode('light'); });
  $('mode-dark').addEventListener('click', function () { setMode('dark'); });
  // 标签式控件按惯例支持左右方向键切换
  ['mode-light', 'mode-dark'].forEach(function (id) {
    $(id).addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      var next = event.key === 'ArrowLeft' ? 'light' : 'dark';
      setMode(next);
      $(next === 'light' ? 'mode-light' : 'mode-dark').focus();
    });
  });

  $('btn-apply').addEventListener('click', applyTheme);
  $('btn-reset').addEventListener('click', resetTheme);
  $('btn-export').addEventListener('click', exportTheme);
  $('btn-import').addEventListener('click', openImport);
  $('btn-reload').addEventListener('click', function () { reloadPalette({}); });
  $('btn-revert-mode').addEventListener('click', revertMode);

  var search = $('row-search');
  if (search) {
    search.addEventListener('input', function () { setFilter(search.value); });
    search.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        clearFilter();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        var first = firstVisibleRow();
        if (first) first.focus();
      }
    });
  }
  if ($('search-clear')) $('search-clear').addEventListener('click', clearFilter);
  if ($('only-dirty')) {
    $('only-dirty').addEventListener('change', function () { setOnlyDirty($('only-dirty').checked); });
  }
  if ($('btn-toggle-groups')) $('btn-toggle-groups').addEventListener('click', toggleAllGroups);
  if ($('btn-copy-dump')) $('btn-copy-dump').addEventListener('click', copyDump);
  if ($('notice-close')) $('notice-close').addEventListener('click', hideNotice);

  // 主题仓库
  if ($('btn-lib-save')) $('btn-lib-save').addEventListener('click', saveLibraryTheme);
  if ($('btn-lib-refresh')) $('btn-lib-refresh').addEventListener('click', function () {
    refreshLibrary().then(function (items) {
      if (items) showToast('仓库共 ' + items.length + ' 个主题');
    });
  });
  if ($('btn-lib-import')) $('btn-lib-import').addEventListener('click', pickArchiveFile);
  if ($('lib-file')) {
    $('lib-file').addEventListener('change', function (event) {
      var input = event.target;
      handleArchiveFile(input.files && input.files[0], input);
    });
  }
  // 名称框回车 = 保存（textarea 默认换行，这里显式拦下来）
  if ($('lib-name')) {
    $('lib-name').addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        saveLibraryTheme();
      }
    });
  }

  // 安装自检
  if ($('btn-health-refresh')) $('btn-health-refresh').addEventListener('click', function () {
    refreshHealth({ toast: true });
  });
  if ($('btn-health-repair')) $('btn-health-repair').addEventListener('click', runHealthRepair);
  if ($('btn-help-open')) $('btn-help-open').addEventListener('click', openHelpModal);

  $('theme-enabled').addEventListener('change', function () { renderDump(); updateButtons(); });
  if ($('theme-name')) $('theme-name').addEventListener('input', renderDump);

  $('modal-close').addEventListener('click', closeModal);
  $('modal-cancel').addEventListener('click', closeModal);
  $('modal-ok').addEventListener('click', onModalOk);
  $('modal').addEventListener('click', function (event) {
    if (event.target === $('modal')) closeModal();
  });

  document.addEventListener('keydown', function (event) {
    var modalOpen = !$('modal').hidden;
    if (event.key === 'Escape' && modalOpen) { closeModal(); return; }
    if (event.key === 'Tab' && modalOpen) { trapModalFocus(event); return; }
    // 弹窗打开时不响应全局快捷键，否则会在用户看不到的背景下触发应用/搜索
    if (modalOpen) return;
    if ((event.ctrlKey || event.metaKey) && (event.key === 'Enter' || event.key === 'NumpadEnter')) {
      event.preventDefault();
      applyTheme();
      return;
    }
    if (event.key === '/' && !isTypingTarget(event.target) && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (search) search.focus();
    }
  });
}

function setMode(mode) {
  state.mode = mode;
  $('mode-light').classList.toggle('is-active', mode === 'light');
  $('mode-dark').classList.toggle('is-active', mode === 'dark');
  $('mode-light').setAttribute('aria-selected', mode === 'light' ? 'true' : 'false');
  $('mode-dark').setAttribute('aria-selected', mode === 'dark' ? 'true' : 'false');
  syncAll();
}

function bootstrap() {
  buildEditor();
  wireEvents();
  setMode('light');
  // 先按本地状态渲染，保证面板不会白屏；随后用 get_theme 校准。
  syncAll();
  applyFilters();
  reloadPalette({});
  // 仓库要单独拉一次（它读的是 themes/ 目录，不是 theme.json）。失败只是列表空，
  // 不影响编辑器 —— refreshLibrary 自己吞异常并写进 #lib-empty。
  refreshLibrary();
  // 安装自检：把应用侧补丁的结果立刻摊在面板上（成功也显示）。
  // 这是用户「装上了却没效果」时唯一能自助定位的地方。
  refreshHealth({});
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}

/* 自动化/调试钩子：面板里没有模块系统，测试脚本只能通过 window 拿内部函数。
 * 只在缺失时挂，不覆盖已有对象。 */
window.__ntsPanel = window.__ntsPanel || {
  state: state,
  callPlugin: callPlugin,
  reloadPalette: reloadPalette,
  refreshLibrary: refreshLibrary,
  saveLibraryTheme: saveLibraryTheme,
  applyLibraryItem: applyLibraryItem,
  exportLibraryItem: exportLibraryItem,
  deleteLibraryItem: deleteLibraryItem,
  importArchive: importArchive,
  effectiveVars: effectiveVars,
  collect: collect,
  syncAll: syncAll,
  doImport: doImport,
  rowsByKey: rowsByKey,
  refreshHealth: refreshHealth,
  renderHealth: renderHealth,
  runHealthRepair: runHealthRepair,
  openHelpModal: openHelpModal
};
