// Canvas lyric renderer, extracted from js/app.js.
// It owns no shared application state: the media element is injected by the
// caller, and the lyric lines arrive through setLyrics().

export class LyricsCanvasRenderer {
    constructor(canvasId, options = {}) {
        this.canvas = document.getElementById(canvasId);
        // Injected so this module reads no player state of its own.
        this.audio = options.audio || null;
        if (!this.canvas) return;

        this.ctx = this.canvas.getContext('2d');
        this.pixelRatio = window.devicePixelRatio || 1;
        this.lines = [];
        this.activeIndex = -1;
        this.scrollY = 0;
        this.targetScrollY = 0;
        this.scrollVelocity = 0;
        this.isDragging = false;
        this.lastTouchY = 0;
        this.lastInteractionTime = 0;
        this.isAnimating = false;

        this.resize();
        this.bindEvents();

        window.addEventListener('resize', () => this.resize());
    }

    resize() {
        if (!this.canvas) return;
        const rect = this.canvas.parentElement.getBoundingClientRect();
        this.width = rect.width;
        this.height = rect.height;
        this.canvas.width = this.width * this.pixelRatio;
        this.canvas.height = this.height * this.pixelRatio;
        this.canvas.style.width = this.width + 'px';
        this.canvas.style.height = this.height + 'px';
        this.ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    }

    bindEvents() {
        // 鼠标/触摸交互
        this.canvas.addEventListener('mousedown', e => this.onPointerDown(e.clientY));
        this.canvas.addEventListener('mousemove', e => this.onPointerMove(e.clientY));
        this.canvas.addEventListener('mouseup', () => this.onPointerUp());
        this.canvas.addEventListener('mouseleave', () => this.onPointerUp());

        this.canvas.addEventListener('touchstart', e => {
            e.preventDefault();
            this.onPointerDown(e.touches[0].clientY);
        }, { passive: false });
        this.canvas.addEventListener('touchmove', e => {
            e.preventDefault();
            this.onPointerMove(e.touches[0].clientY);
        }, { passive: false });
        this.canvas.addEventListener('touchend', () => this.onPointerUp());

        // 鼠标滚轮
        this.canvas.addEventListener('wheel', e => {
            e.preventDefault();
            this.lastInteractionTime = performance.now();
            this.targetScrollY += e.deltaY * 0.5;
            this.clampScroll();
        }, { passive: false });

        // 点击跳转
        this.canvas.addEventListener('click', e => {
            if (this.isDragging) return;
            const rect = this.canvas.getBoundingClientRect();
            const clickY = e.clientY - rect.top;
            this.handleClick(clickY);
        });
    }

    onPointerDown(y) {
        this.isDragging = true;
        this.lastTouchY = y;
        this.scrollVelocity = 0;
        this.lastInteractionTime = performance.now();
    }

    onPointerMove(y) {
        if (!this.isDragging) return;
        const dy = this.lastTouchY - y;
        this.scrollVelocity = dy * 60;
        this.targetScrollY += dy;
        this.lastTouchY = y;
        this.clampScroll();
    }

    onPointerUp() {
        this.isDragging = false;
        this.lastInteractionTime = performance.now();
    }

    clampScroll() {
        const totalHeight = this.lines.reduce((sum, l) => sum + l.height + 16, 0);
        const maxScroll = Math.max(0, totalHeight - this.height * 0.5);
        this.targetScrollY = Math.max(-this.height * 0.3, Math.min(maxScroll, this.targetScrollY));
    }

    handleClick(clickY) {
        const focalY = this.height * 0.35;
        let y = focalY - this.scrollY;

        for (let i = 0; i < this.lines.length; i++) {
            const line = this.lines[i];
            const lineBottom = y + line.height;

            if (clickY >= y && clickY <= lineBottom) {
                // 点击跳转播放
                this.audio.currentTime = line.time;
                this.audio.play();
                break;
            }
            y = lineBottom + 16;
        }
    }

    setLyrics(parsedLyrics) {
        this.lines = parsedLyrics.map((item, idx) => ({
            time: item.time,
            text: item.text,
            words: [],
            translation: item.html?.includes('lyric-trans')
                ? item.html.match(/<div class="lyric-trans">(.*?)<\/div>/)?.[1]
                : null,
            height: 0,  // 动态计算
            measured: false
        }));

        this.measureLines();
        this.scrollY = -this.height * 0.3;
        this.targetScrollY = this.scrollY;
        this.activeIndex = -1;

        if (!this.isAnimating) {
            this.isAnimating = true;
            this.animate();
        }
    }

    measureLines() {
        const ctx = this.ctx;
        const isMobile = this.width < 768; // Match aura-music breakpoint
        // ★ 字体配置 (aura-music)
        const baseSize = isMobile ? 32 : 40;
        const transSize = isMobile ? 18 : 22;
        const mainFont = `800 ${baseSize}px "PingFang SC", "Noto Sans SC", "Inter", sans-serif`;
        const transFont = `500 ${transSize}px "PingFang SC", "Noto Sans SC", "Inter", sans-serif`;
        this.paddingX = isMobile ? 24 : 56; // 增加边距
        const maxWidth = this.width - this.paddingX * 2;

        this.lines.forEach(line => {
            ctx.font = mainFont;
            const mainMetrics = ctx.measureText(line.text || '');
            const mainWidth = mainMetrics.width;
            const mainLines = Math.ceil(mainWidth / maxWidth);
            const mainHeight = mainLines * (baseSize * 1.35); // line-height 1.35

            let transHeight = 0;
            if (line.translation) {
                ctx.font = transFont;
                const transMetrics = ctx.measureText(line.translation);
                const transLines = Math.ceil(transMetrics.width / maxWidth);
                transHeight = transLines * (transSize * 1.3) + 8; // margin-top 8
            }

            line.height = mainHeight + transHeight + 20; // margin-bottom 20
            line.measured = true;
        });
    }

    update(currentTime) {
        if (!this.lines.length) return;

        // 找当前行
        let newActive = 0;
        for (let i = 0; i < this.lines.length; i++) {
            if (this.lines[i].time <= currentTime + 0.2) { // Slightly fast anticipation
                newActive = i;
            } else {
                break;
            }
        }

        // 更新滚动目标
        const userScrolling = performance.now() - this.lastInteractionTime < 3000;
        if (!userScrolling && !this.isDragging) {
            // 计算目标行位置
            let targetY = 0;
            for (let i = 0; i < newActive; i++) {
                targetY += this.lines[i].height;
            }
            targetY += this.lines[newActive]?.height * 0.5 || 0;
            this.targetScrollY = targetY;
        }

        this.activeIndex = newActive;

        // ★ 弹簧物理滚动 (aura-music 参数)
        // Stiffness: 120 (loose) -> 300-400 (snap)
        // Damping: 20 -> 35-40
        const stiffness = this.isDragging ? 0 : (userScrolling ? 150 : 350);
        const damping = this.isDragging ? 10 : 35;
        const dt = 1 / 60;

        const displacement = this.scrollY - this.targetScrollY;
        const springForce = -stiffness * displacement;
        const dampingForce = -damping * this.scrollVelocity;
        const acceleration = springForce + dampingForce;

        this.scrollVelocity += acceleration * dt;
        this.scrollY += this.scrollVelocity * dt;

        if (Math.abs(this.scrollVelocity) < 0.1 && Math.abs(displacement) < 0.5) {
            this.scrollY = this.targetScrollY;
            this.scrollVelocity = 0;
        }
    }

    render(currentTime) {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.width, this.height);

        if (!this.lines.length) {
            ctx.fillStyle = 'rgba(255,255,255,0.4)';
            ctx.font = '800 24px "PingFang SC", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('♪ 播放音乐以查看歌词', this.width / 2, this.height / 2);
            return;
        }

        const isMobile = this.width < 768;
        const baseSize = isMobile ? 32 : 40;
        const transSize = isMobile ? 18 : 22;
        const mainFont = `800 ${baseSize}px "PingFang SC", "Noto Sans SC", "Inter", sans-serif`;
        const transFont = `500 ${transSize}px "PingFang SC", "Noto Sans SC", "Inter", sans-serif`;

        // Focal Point: 35% from top (desktop) or near center?
        // aura-music uses 0.35 (ish)
        const focalY = this.height * 0.35;

        let y = focalY - this.scrollY;

        for (let i = 0; i < this.lines.length; i++) {
            const line = this.lines[i];
            const lineBottom = y + line.height;

            // 视口裁剪
            if (lineBottom < -100 || y > this.height + 100) {
                y = lineBottom; // Note: margin included in line.height now
                continue;
            }

            const isActive = i === this.activeIndex;

            // 渐变与模糊逻辑
            const distFromFocal = Math.abs(y + line.height / 2 - focalY);
            const normDist = Math.min(distFromFocal / (this.height * 0.5), 1);

            // aura-music opacity logic
            let opacity = isActive ? 1 : 0.3 + (0.7 * (1 - Math.pow(normDist, 0.5))) * 0.2;
            // Simplified: Active 1.0, others 0.3 dim
            if (!isActive) opacity = 0.3; // Stricter contrast like aura-music

            ctx.save();
            ctx.globalAlpha = opacity;

            // 缩放效果 (aura-music: Active 1.03, others 1.0)
            const scale = isActive ? 1.03 : 1.0;

            // Center of the line for scaling (vertically), but left aligned horizontally
            const centerY = y + line.height / 2;
            // Translate to paddingX, centerY
            ctx.translate(this.paddingX, centerY);
            ctx.scale(scale, scale);
            // Translate back up to top-left of text block (relative to center)
            ctx.translate(0, -line.height / 2);

            // 渲染主歌词
            ctx.font = mainFont;
            ctx.textBaseline = 'top';
            ctx.textAlign = 'left'; // 明确左对齐

            // aura-music: Active White, Inactive White (opacity handles dimming usually, or explicit color)
            // Inactiv color is rgba(255,255,255,0.85) but with opacity 0.3 applied globally
            ctx.fillStyle = '#FFFFFF';
            ctx.fillText(line.text, 0, 0);

            // 渲染翻译
            if (line.translation) {
                ctx.font = transFont;
                ctx.fillStyle = 'rgba(255,255,255,0.6)';
                ctx.fillText(line.translation, 0, baseSize * 1.35 + 8);
            }

            ctx.restore();

            y = lineBottom;
        }

        // 顶部/底部渐隐遮罩
        this.drawMask(ctx);
    }



    drawMask(ctx) {
        // 顶部渐隐
        const topGradient = ctx.createLinearGradient(0, 0, 0, this.height * 0.15);
        topGradient.addColorStop(0, 'rgba(0,0,0,1)');
        topGradient.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = topGradient;
        ctx.fillRect(0, 0, this.width, this.height * 0.15);

        // 底部渐隐
        const bottomGradient = ctx.createLinearGradient(0, this.height * 0.85, 0, this.height);
        bottomGradient.addColorStop(0, 'rgba(0,0,0,0)');
        bottomGradient.addColorStop(1, 'rgba(0,0,0,1)');
        ctx.fillStyle = bottomGradient;
        ctx.fillRect(0, this.height * 0.85, this.width, this.height * 0.15);

        ctx.globalCompositeOperation = 'source-over';
    }

    animate() {
        if (!this.isAnimating) return;

        const time = this.audio?.currentTime || 0;
        this.update(time);
        this.render(time);

        requestAnimationFrame(() => this.animate());
    }

    stop() {
        this.isAnimating = false;
    }
}
