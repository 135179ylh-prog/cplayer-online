// WebGL cover-colour background renderer, extracted from js/app.js.
// It owns no shared application state: the playing flag and the reduced-motion
// probe are injected by the caller so this module stays independent of the
// player module-level variables.

export class FluidBackground {
    constructor(canvasId, options = {}) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) return;

        this.gl = this.canvas.getContext('webgl') || this.canvas.getContext('experimental-webgl');
        if (!this.gl) {
            console.warn('WebGL 不支持');
            return;
        }

        this.isPlaying = false;
        // Injected so this module reads no player state of its own. Defaulting to
        // "no preference" keeps the animation behaviour identical when the caller
        // does not pass a probe.
        this.prefersReducedMotion = typeof options.prefersReducedMotion === 'function'
            ? options.prefersReducedMotion
            : () => false;
        this.animationFrameId = null;
        this.boundAnimate = () => this.animate();
        this.timeAccumulator = 0;
        this.lastFrameTime = performance.now();

        // 默认颜色 (aura-music)
        this.colors = [
            'rgb(60, 20, 80)',
            'rgb(100, 40, 60)',
            'rgb(20, 20, 40)',
            'rgb(40, 40, 90)'
        ];

        this.initShader();
        this.resize();
        this.render();
        this.setPlaying(options.isPlaying === true);
        window.addEventListener('resize', () => this.resize());
    }

    parseColor(colorStr) {
        const match = colorStr.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        if (!match) return [0, 0, 0];
        return [parseInt(match[1], 10) / 255, parseInt(match[2], 10) / 255, parseInt(match[3], 10) / 255];
    }

    initShader() {
        const gl = this.gl;
        const vs = `attribute vec2 position; void main() { gl_Position = vec4(position, 0.0, 1.0); }`;
        const fs = `
            precision highp float;
            uniform vec2 uResolution; uniform float uTime;
            uniform vec3 uColor1, uColor2, uColor3, uColor4;
            #define S(a,b,t) smoothstep(a,b,t)
            mat2 Rot(float a) { float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }
            vec2 hash(vec2 p) { p = vec2(dot(p, vec2(2127.1, 81.17)), dot(p, vec2(1269.5, 283.37))); return fract(sin(p) * 43758.5453); }
            float noise(vec2 p) {
                vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
                float n = mix(mix(dot(-1.0 + 2.0 * hash(i), f), dot(-1.0 + 2.0 * hash(i + vec2(1,0)), f - vec2(1,0)), u.x),
                              mix(dot(-1.0 + 2.0 * hash(i + vec2(0,1)), f - vec2(0,1)), dot(-1.0 + 2.0 * hash(i + vec2(1,1)), f - vec2(1,1)), u.x), u.y);
                return 0.5 + 0.5 * n;
            }
            void main() {
                vec2 uv = gl_FragCoord.xy / uResolution.xy;
                float ratio = uResolution.x / uResolution.y;
                vec2 tuv = uv - 0.5;
                float degree = noise(vec2(uTime * 0.1, tuv.x * tuv.y));
                tuv.y *= 1.0 / ratio;
                tuv *= Rot(radians((degree - 0.5) * 720.0 + 180.0));
                tuv.y *= ratio;
                float frequency = 5.0, amplitude = 30.0, speed = uTime * 2.0;
                tuv.x += sin(tuv.y * frequency + speed) / amplitude;
                tuv.y += sin(tuv.x * frequency * 1.5 + speed) / (amplitude * 0.5);
                vec3 layer1 = mix(uColor1, uColor2, S(-0.3, 0.2, (tuv * Rot(radians(-5.0))).x));
                vec3 layer2 = mix(uColor3, uColor4, S(-0.3, 0.2, (tuv * Rot(radians(-5.0))).x));
                gl_FragColor = vec4(mix(layer1, layer2, S(0.5, -0.3, tuv.y)), 1.0);
            }
        `;
        const createShader = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
        const vShader = createShader(gl.VERTEX_SHADER, vs), fShader = createShader(gl.FRAGMENT_SHADER, fs);
        if (!vShader || !fShader) return;
        this.program = gl.createProgram();
        gl.attachShader(this.program, vShader); gl.attachShader(this.program, fShader);
        gl.linkProgram(this.program); gl.useProgram(this.program);
        const posBuffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
        const posLoc = gl.getAttribLocation(this.program, 'position');
        gl.enableVertexAttribArray(posLoc); gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
        this.uResolution = gl.getUniformLocation(this.program, 'uResolution');
        this.uTime = gl.getUniformLocation(this.program, 'uTime');
        this.uColor1 = gl.getUniformLocation(this.program, 'uColor1');
        this.uColor2 = gl.getUniformLocation(this.program, 'uColor2');
        this.uColor3 = gl.getUniformLocation(this.program, 'uColor3');
        this.uColor4 = gl.getUniformLocation(this.program, 'uColor4');
    }

    resize() {
        if (!this.gl) return;
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        if (document.visibilityState === 'visible' && !this.shouldAnimate()) this.render();
    }

    async extractColorsFromImage(imgUrl) {
        try {
            // console.log('🎨 开始从封面提取颜色:', imgUrl);
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = imgUrl;

            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
                setTimeout(reject, 5000); // 5秒超时
            });

            if (typeof ColorThief !== 'undefined') {
                const colorThief = new ColorThief();
                const palette = colorThief.getPalette(img, 4);
                // console.log('🎨 ColorThief 提取的调色板:', palette);

                if (palette && palette.length >= 4) {
                    // 确保格式正确：rgb(r, g, b) 带空格
                    this.setColors(palette.map(([r, g, b]) => {
                        const factor = 0.8;
                        const nr = Math.round(r * factor);
                        const ng = Math.round(g * factor);
                        const nb = Math.round(b * factor);
                        return `rgb(${nr}, ${ng}, ${nb})`;
                    }));
                    console.log('🎨 更新后的背景颜色:', this.colors);
                    return;
                }
            } else {
                console.warn('⚠️ ColorThief 未加载');
            }

            // 降级：简单采样四个角落的颜色
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = 2;
            canvas.height = 2;
            ctx.drawImage(img, 0, 0, 2, 2);
            const data = ctx.getImageData(0, 0, 2, 2).data;

            this.setColors([
                `rgb(${Math.round(data[0] * 0.8)}, ${Math.round(data[1] * 0.8)}, ${Math.round(data[2] * 0.8)})`,
                `rgb(${Math.round(data[4] * 0.8)}, ${Math.round(data[5] * 0.8)}, ${Math.round(data[6] * 0.8)})`,
                `rgb(${Math.round(data[8] * 0.8)}, ${Math.round(data[9] * 0.8)}, ${Math.round(data[10] * 0.8)})`,
                `rgb(${Math.round(data[12] * 0.8)}, ${Math.round(data[13] * 0.8)}, ${Math.round(data[14] * 0.8)})`
            ]);
            console.log('🎨 降级采样的背景颜色:', this.colors);
        } catch (e) {
            console.warn('❌ 颜色提取失败:', e);
        }
    }

    render() {
        if (!this.gl || !this.program) return;
        const gl = this.gl, now = performance.now(), delta = now - this.lastFrameTime;
        this.lastFrameTime = now;
        if (this.isPlaying) this.timeAccumulator += delta;
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.useProgram(this.program);
        gl.uniform2f(this.uResolution, this.canvas.width, this.canvas.height);
        gl.uniform1f(this.uTime, this.timeAccumulator * 0.0005);
        const [c1, c2, c3, c4] = this.colors.map(c => this.parseColor(c));
        gl.uniform3f(this.uColor1, c1[0], c1[1], c1[2]);
        gl.uniform3f(this.uColor2, c2[0], c2[1], c2[2]);
        gl.uniform3f(this.uColor3, c3[0], c3[1], c3[2]);
        gl.uniform3f(this.uColor4, c4[0], c4[1], c4[2]);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    shouldAnimate() {
        return !!(this.gl && this.program && this.isPlaying && !this.prefersReducedMotion() && document.visibilityState === 'visible');
    }

    syncAnimation() {
        if (this.shouldAnimate()) {
            if (this.animationFrameId === null) {
                this.lastFrameTime = performance.now();
                this.animationFrameId = requestAnimationFrame(this.boundAnimate);
            }
            return;
        }
        if (this.animationFrameId !== null) cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
        if (document.visibilityState === 'visible') this.render();
    }

    animate() {
        this.animationFrameId = null;
        if (!this.shouldAnimate()) return;
        this.render();
        this.animationFrameId = requestAnimationFrame(this.boundAnimate);
    }

    setPlaying(p) {
        this.isPlaying = !!p;
        this.syncAnimation();
    }

    setColors(c) {
        if (!c || c.length < 4) return;
        this.colors = c;
        if (!this.shouldAnimate()) this.render();
    }
}
