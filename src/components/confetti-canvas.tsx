import { useEffect, useRef } from "react";

type ConfettiCanvasProps = {
  active: boolean;
  durationMs?: number;
  onDone?: () => void;
};

type ConfettiParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rotation: number;
  rotationSpeed: number;
  color: string;
};

const COLORS = [
  "#fca311", // orange
  "#2a9d8f", // teal
  "#e63946", // red
  "#457b9d", // blue
  "#a855f7", // purple
  "#22c55e", // green
];

function prefersReducedMotion() {
  if (typeof window === "undefined") return true;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

export default function ConfettiCanvas({
  active,
  durationMs = 2600,
  onDone,
}: ConfettiCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const onDoneRef = useRef<ConfettiCanvasProps["onDone"]>(onDone);

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (!active) return;
    if (prefersReducedMotion()) {
      const timer = window.setTimeout(() => onDoneRef.current?.(), 50);
      return () => window.clearTimeout(timer);
    }

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    window.addEventListener("resize", resize);

    const particles: ConfettiParticle[] = [];
    const particleCount = 170;
    for (let i = 0; i < particleCount; i++) {
      const x = randomBetween(0, window.innerWidth);
      const y = randomBetween(-window.innerHeight * 0.25, 0);
      particles.push({
        x,
        y,
        vx: randomBetween(-2.2, 2.2),
        vy: randomBetween(3.2, 7.2),
        size: randomBetween(6, 12),
        rotation: randomBetween(0, Math.PI * 2),
        rotationSpeed: randomBetween(-0.18, 0.18),
        color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
      });
    }

    const startedAt = performance.now();
    const gravity = 0.08;
    const drag = 0.995;

    const render = (t: number) => {
      const elapsed = t - startedAt;
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

      const fade = Math.max(0, 1 - elapsed / durationMs);
      ctx.globalAlpha = Math.min(1, fade);

      for (const p of particles) {
        p.vy += gravity;
        p.vx *= drag;
        p.vy *= drag;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.rotationSpeed;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.65);
        ctx.restore();
      }

      // End early once everything has fallen past the viewport.
      const done = elapsed >= durationMs || particles.every((p) => p.y > window.innerHeight + 40);
      if (done) {
        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
        onDoneRef.current?.();
        return;
      }

      rafRef.current = window.requestAnimationFrame(render);
    };

    rafRef.current = window.requestAnimationFrame(render);

    return () => {
      window.removeEventListener("resize", resize);
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [active, durationMs]);

  if (!active) return null;

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 z-50 pointer-events-none"
      aria-hidden="true"
    />
  );
}
