import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import * as THREE from 'three';
import { ArrowLeft, Crosshair, MousePointer2, Target, Trophy, X } from 'lucide-react';
import { useCardProgress } from '@/components/CardProgress';
import { filterDiscovered, parseDiscoveryFilter, wordProgressKey } from '@/lib/cardProgress';
import { customWordsToWords, loadCustomWords } from '@/lib/customWords';
import { loadWordLists } from '@/lib/wordLists';
import { shuffle, vocabulary, type Word } from '@/lib/vocabulary';
import { isQuizReadyWord } from '@/lib/bulkWordImport';

type Direction = 'meaning' | 'word' | 'reading';
type Props = { params: URLSearchParams };
type AnswerRecord = { word: Word; choice: string; correct: boolean };
type WorldSlot = { x: number; y: number; z: number };
type TargetActor = {
  group: THREE.Group;
  surface: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  texture?: THREE.CanvasTexture;
  from: THREE.Vector3;
  to: THREE.Vector3;
  moveStart: number;
  moveDuration: number;
};
type ProjectileActor = { mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>; velocity: THREE.Vector3; age: number };
type ThreeGame = { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; actors: TargetActor[]; raycaster: THREE.Raycaster; frame: number; canvas: HTMLCanvasElement; boss?: THREE.Group; projectiles: ProjectileActor[] };

const labelFor = (word: Word, direction: Direction) => direction === 'meaning' ? word.meaning : direction === 'reading' ? word.reading : word.expression;
const slots: WorldSlot[] = [
  { x: -5.2, y: 2.25, z: -11 }, { x: -1.8, y: 3.35, z: -13 }, { x: 1.8, y: 2.1, z: -9.5 }, { x: 5.2, y: 3.2, z: -12 },
  { x: -4.7, y: 3.35, z: -15 }, { x: -1.7, y: 1.95, z: -9 }, { x: 2.2, y: 3.25, z: -14 }, { x: 4.9, y: 1.95, z: -9.5 },
];
function newShuffle(previous: number[]) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const candidate = shuffle(slots.map((_, index) => index)).slice(0, previous.length);
    if (candidate.every((slot, index) => slot !== previous[index])) return candidate;
  }
  return previous.map((slot) => (slot + 4) % slots.length);
}

function makeTargetTexture(choice: Word, direction: Direction, index: number) {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 320;
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, '#123346');
  gradient.addColorStop(1, '#07141f');
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = 'rgba(118,232,255,.78)';
  context.lineWidth = 8;
  context.strokeRect(7, 7, canvas.width - 14, canvas.height - 14);
  context.fillStyle = 'rgba(118,232,255,.72)';
  context.font = 'bold 24px system-ui, sans-serif';
  context.textAlign = 'left';
  context.fillText(`TARGET 0${index + 1}`, 30, 48);
  context.fillStyle = '#f2fbff';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = direction === 'word' ? 'bold 88px system-ui, sans-serif' : 'bold 74px system-ui, sans-serif';
  const text = labelFor(choice, direction);
  const maxWidth = canvas.width - 64;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width > maxWidth && line) { lines.push(line); line = word; }
    else line = candidate;
  }
  if (line) lines.push(line);
  const visibleLines = lines.slice(0, 3);
  const lineHeight = 55;
  const startY = canvas.height / 2 + 12 - ((visibleLines.length - 1) * lineHeight) / 2;
  visibleLines.forEach((item, lineIndex) => context.fillText(item, canvas.width / 2, startY + lineIndex * lineHeight, maxWidth));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function launchBossProjectile(game: ThreeGame, difficulty: number) {
  if (!game.boss) return;
  const origin = game.boss.position.clone().add(new THREE.Vector3(0, 0.05, 1.35));
  // Aim at the player's upper body, with more vertical error at easier settings.
  const target = game.camera.position.clone();
  target.y -= 0.35;
  const verticalSpread = THREE.MathUtils.lerp(1.05, 0.12, (difficulty - 1) / 9);
  target.y += (Math.random() * 2 - 1) * verticalSpread;
  // Noticeably faster at the top end: a hard shot crosses the range in about half a second.
  const shotSpeed = THREE.MathUtils.lerp(8, 34, (difficulty - 1) / 9);
  const velocity = target.sub(origin).normalize().multiplyScalar(shotSpeed);
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 14, 14),
    new THREE.MeshStandardMaterial({ color: '#ff526f', emissive: '#ff173d', emissiveIntensity: 2.8, roughness: 0.25 }),
  );
  mesh.position.copy(origin);
  game.scene.add(mesh);
  game.projectiles.push({ mesh, velocity, age: 0 });
}

export function AimShooterMode({ params }: Props) {
  const [, setLocation] = useLocation();
  const { seen: discovered } = useCardProgress();
  const mountRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<ThreeGame | null>(null);
  const actorSurfacesRef = useRef<Array<TargetActor['surface']>>([]);
  const controlRef = useRef<'cursor' | 'aim'>('aim');
  const sensitivityRef = useRef(1);
  const frameCapRef = useRef<30 | 60 | 120>(60);
  const choicesRef = useRef<Word[]>([]);
  const answerRef = useRef<(choice: Word | null) => void>(() => undefined);
  const [control, setControl] = useState<'cursor' | 'aim'>('aim');
  const [sensitivity, setSensitivity] = useState(1);
  const [positions, setPositions] = useState([0, 1, 2, 3]);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<AnswerRecord[]>([]);
  const [feedback, setFeedback] = useState<'correct' | 'miss' | null>(null);
  const [locked, setLocked] = useState(false);
  const [webglError, setWebglError] = useState(false);
  const [playerHealth, setPlayerHealth] = useState(100);
  const [gameOver, setGameOver] = useState(false);
  const playerHealthRef = useRef(100);
  const invulnerableUntilRef = useRef(0);
  const gameOverRef = useRef(false);
  const damagePlayerRef = useRef<() => void>(() => undefined);
  const discoveryFilter = parseDiscoveryFilter(params.get('discovery'));
  const direction: Direction = params.get('direction') === 'word' ? 'word' : params.get('direction') === 'reading' ? 'reading' : 'meaning';
  const bossFight = params.get('boss') === '1';
  const count = Math.min(30, Math.max(1, Number(params.get('count')) || 10));
  const swapSeconds = Math.min(10, Math.max(1, Math.round(Number(params.get('swapSeconds')) || 4)));
  const movementSpeed = Math.min(10, Math.max(1, Math.round(Number(params.get('movementSpeed')) || 5)));
  const bossDifficulty = Math.min(10, Math.max(1, Math.round(Number(params.get('bossDifficulty')) || 5)));
  const requestedFrameCap = Number(params.get('frameCap'));
  const frameCap: 30 | 60 | 120 = requestedFrameCap === 30 ? 30 : requestedFrameCap === 120 ? 120 : 60;
  const rawDecks = (params.get('decks') || 'ALL').split(',');
  const savedListId = params.get('listId');
  const customWords = useMemo(() => customWordsToWords(loadCustomWords()), []);
  const savedIds = useMemo(() => loadWordLists().find((list) => list.id === savedListId)?.wordIds ?? [], [savedListId]);
  const allWords = useMemo(() => {
    if (rawDecks.includes('ALL')) return [...vocabulary, ...customWords];
    const levels = rawDecks.filter((item) => /^N[1-5]$/.test(item));
    const selected = vocabulary.filter((word) => levels.includes(word.level));
    const mine = rawDecks.includes('MY_WORDS') ? customWords : [];
    const saved = rawDecks.includes('FAVORITES') ? [...vocabulary, ...customWords].filter((word) => savedIds.includes(word.id)) : [];
    return [...new Map([...selected, ...mine, ...saved].map((word) => [word.id, word])).values()];
  }, [customWords, savedIds]);
  const pool = useMemo(() => filterDiscovered(allWords.filter(isQuizReadyWord), wordProgressKey, discovered, discoveryFilter), [allWords, discovered, discoveryFilter]);
  const cards = useMemo(() => shuffle(pool).slice(0, count), [pool, count]);
  const word = cards[index];
  const choices = useMemo(() => {
    if (!word) return [];
    const answerLabel = labelFor(word, direction).normalize('NFKC').trim().toLowerCase();
    const used = new Set([answerLabel]);
    const distractors: Word[] = [];
    for (const candidate of shuffle(allWords.filter((item) => isQuizReadyWord(item) && item.id !== word.id))) {
      const label = labelFor(candidate, direction).normalize('NFKC').trim().toLowerCase();
      if (!label || used.has(label)) continue;
      used.add(label);
      distractors.push(candidate);
      if (distractors.length === 3) break;
    }
    return shuffle([word, ...distractors]);
  }, [word, direction, allWords]);
  const [bossHealth, setBossHealth] = useState(cards.length);
  const bossHealthRef = useRef(cards.length);
  bossHealthRef.current = bossHealth;
  gameOverRef.current = gameOver;
  damagePlayerRef.current = () => {
    const now = performance.now();
    if (!bossFight || gameOverRef.current || now < invulnerableUntilRef.current) return;
    invulnerableUntilRef.current = now + 900;
    const remaining = Math.max(0, playerHealthRef.current - 25);
    playerHealthRef.current = remaining;
    setPlayerHealth(remaining);
    if (remaining === 0) {
      document.exitPointerLock?.();
      setControl('cursor');
      setGameOver(true);
    }
  };

  const finish = (finalAnswers: AnswerRecord[]) => {
    const score = finalAnswers.filter((item) => item.correct).length;
    sessionStorage.setItem('kotoba-last-result', JSON.stringify({ score, total: finalAnswers.length, answers: finalAnswers, level: rawDecks.join(' + ') || 'Mixed', finishedAt: new Date().toISOString() }));
    document.exitPointerLock?.();
    setLocation('/results');
  };
  const answer = (choice: Word | null) => {
    if (!word || feedback || gameOverRef.current) return;
    const correct = !!choice && choice.id === word.id;
    if (bossFight && correct) {
      const remaining = Math.max(0, bossHealthRef.current - 1);
      bossHealthRef.current = remaining;
      setBossHealth(remaining);
    }
    const nextAnswers = [...answers, { word, choice: choice ? labelFor(choice, direction) : '(missed shot)', correct }];
    setAnswers(nextAnswers);
    setFeedback(correct ? 'correct' : 'miss');
    window.setTimeout(() => {
      if (index + 1 >= cards.length) finish(nextAnswers);
      else { setPositions([0, 1, 2, 3]); setIndex((value) => value + 1); setFeedback(null); }
    }, 650);
  };
  choicesRef.current = choices;
  answerRef.current = answer;
  controlRef.current = control;
  sensitivityRef.current = sensitivity;
  frameCapRef.current = frameCap;

  // ESC returns from pointer-lock aim to cursor controls; another ESC exits the mode.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (controlRef.current === 'aim') {
        event.preventDefault();
        document.exitPointerLock?.();
        setControl('cursor');
      } else {
        document.exitPointerLock?.();
        setLocation('/quiz');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setLocation]);

  // Build a real WebGL scene once. The target panels are meshes in 3D space,
  // not DOM cards animated over a flat screen.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch {
      setWebglError(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.domElement.className = 'absolute inset-0 h-full w-full';
    renderer.domElement.setAttribute('aria-label', '3D shooting range');
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#06111c');
    scene.fog = new THREE.FogExp2('#06111c', 0.018);
    const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 1.65, 0);
    scene.add(new THREE.HemisphereLight('#b7eeff', '#142331', 2.2));
    const keyLight = new THREE.DirectionalLight('#b7eeff', 2.8);
    keyLight.position.set(-5, 9, 4);
    scene.add(keyLight);
    const cyanLight = new THREE.PointLight('#15bfd2', 24, 32);
    cyanLight.position.set(0, 4, -12);
    scene.add(cyanLight);
    const amberLight = new THREE.PointLight('#ffae54', 16, 22);
    amberLight.position.set(5, 3, -7);
    scene.add(amberLight);

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({ color: '#091521', roughness: 0.72, metalness: 0.26 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    scene.add(floor);
    const grid = new THREE.GridHelper(80, 80, '#1b93a8', '#17303b');
    grid.position.y = 0.012;
    const gridMaterial = grid.material as THREE.Material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.38;
    scene.add(grid);
    const backWall = new THREE.Mesh(new THREE.PlaneGeometry(48, 14), new THREE.MeshStandardMaterial({ color: '#0c1b28', emissive: '#071927', roughness: 0.9, side: THREE.DoubleSide }));
    backWall.position.set(0, 5, -22);
    scene.add(backWall);
    const railMaterial = new THREE.MeshStandardMaterial({ color: '#174456', emissive: '#08313d', metalness: 0.65, roughness: 0.35 });
    for (const x of [-7, -5, 5, 7]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.12, 5.5, 0.16), railMaterial);
      pillar.position.set(x, 2.75, -13);
      scene.add(pillar);
    }
    for (const z of [-6, -12, -18]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(16, 0.06, 0.06), new THREE.MeshBasicMaterial({ color: z === -12 ? '#44d9ee' : '#286476' }));
      rail.position.set(0, 0.3, z);
      scene.add(rail);
    }

    let boss: THREE.Group | undefined;
    if (bossFight) {
      boss = new THREE.Group();
      const armor = new THREE.MeshStandardMaterial({ color: '#492255', emissive: '#210d30', metalness: 0.72, roughness: 0.28 });
      const darkArmor = new THREE.MeshStandardMaterial({ color: '#182b3d', metalness: 0.58, roughness: 0.35 });
      const glow = new THREE.MeshStandardMaterial({ color: '#ff456b', emissive: '#ff143e', emissiveIntensity: 3.2, metalness: 0.25, roughness: 0.2 });
      const core = new THREE.Mesh(new THREE.IcosahedronGeometry(1.15, 1), armor);
      boss.add(core);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.7, 20, 16), darkArmor);
      head.position.set(0, 0.9, 0.08);
      boss.add(head);
      const reactor = new THREE.Mesh(new THREE.SphereGeometry(0.36, 16, 12), glow);
      reactor.position.set(0, 0.15, 0.86);
      boss.add(reactor);
      for (const side of [-1, 1]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), glow);
        eye.position.set(side * 0.32, 0.98, 0.66);
        boss.add(eye);
        const horn = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.65, 8), armor);
        horn.position.set(side * 0.48, 1.47, 0.02);
        horn.rotation.z = side * -0.38;
        boss.add(horn);
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.48, 1.15, 0.58), darkArmor);
        arm.position.set(side * 1.18, -0.22, 0);
        arm.rotation.z = side * -0.18;
        boss.add(arm);
      }
      boss.position.set(0, 2.65, -20);
      scene.add(boss);
    }

    const actors: TargetActor[] = [];
    const startChoices = choicesRef.current;
    startChoices.forEach((choice, index) => {
      const group = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.98, 0.12), new THREE.MeshStandardMaterial({ color: '#0b2838', emissive: '#062632', metalness: 0.62, roughness: 0.32 }));
      group.add(body);
      const texture = makeTargetTexture(choice, direction, index);
      const surfaceMaterial = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false });
      const surface = new THREE.Mesh(new THREE.PlaneGeometry(1.88, 0.91), surfaceMaterial);
      surface.position.z = 0.09;
      surface.userData.targetIndex = index;
      group.add(surface);
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.98, 1.01, 0.14)), new THREE.LineBasicMaterial({ color: '#78eaff', transparent: true, opacity: 0.88 }));
      group.add(edge);
      const slot = slots[index] ?? slots[0];
      group.position.set(slot.x, slot.y, slot.z);
      scene.add(group);
      actors.push({ group, surface, texture, from: group.position.clone(), to: group.position.clone(), moveStart: 0, moveDuration: 1 });
    });
    actorSurfacesRef.current = actors.map((actor) => actor.surface);
    const raycaster = new THREE.Raycaster();
    raycaster.far = 45;
    const game: ThreeGame = { renderer, scene, camera, actors, raycaster, frame: 0, canvas: renderer.domElement, boss, projectiles: [] };
    gameRef.current = game;

    let yaw = 0;
    let pitch = 0;
    let previousRender = 0;
    let verticalVelocity = 0;
    let jumpsUsed = 0;
    const groundHeight = 1.65;
    const movementKeys = new Set<string>();
    const onMoveKeyDown = (event: KeyboardEvent) => {
      if (gameOverRef.current) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, button, a, [contenteditable="true"]')) return;
      if (event.code === 'Space') {
        event.preventDefault();
        if (!event.repeat && jumpsUsed < 2) {
          verticalVelocity = 7.5;
          jumpsUsed += 1;
        }
        return;
      }
      const key = event.key.toLowerCase();
      if (!['w', 'a', 's', 'd'].includes(key)) return;
      event.preventDefault();
      movementKeys.add(key);
    };
    const onMoveKeyUp = (event: KeyboardEvent) => movementKeys.delete(event.key.toLowerCase());
    const onBlur = () => movementKeys.clear();
    const onMouseMove = (event: MouseEvent) => {
      if (document.pointerLockElement !== renderer.domElement || controlRef.current !== 'aim') return;
      yaw -= event.movementX * sensitivityRef.current * 0.0022;
      pitch -= event.movementY * sensitivityRef.current * 0.0022;
      pitch = Math.max(-1.05, Math.min(1.05, pitch));
      camera.rotation.order = 'YXZ';
      camera.rotation.set(pitch, yaw, 0);
    };
    const onPointerLock = () => setLocked(document.pointerLockElement === renderer.domElement);
    const onCanvasClick = (event: MouseEvent) => {
      if (controlRef.current === 'aim' && document.pointerLockElement !== renderer.domElement) {
        renderer.domElement.requestPointerLock?.();
        return;
      }
      const rect = renderer.domElement.getBoundingClientRect();
      const pointer = controlRef.current === 'aim'
        ? new THREE.Vector2(0, 0)
        : new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(actorSurfacesRef.current, false);
      if (!hits.length) {
        if (controlRef.current === 'aim') answerRef.current(null);
        return;
      }
      const targetIndex = Number(hits[0].object.userData.targetIndex);
      answerRef.current(choicesRef.current[targetIndex] ?? null);
    };

    const resize = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    };
    const animate = (now: number) => {
      game.frame = window.requestAnimationFrame(animate);
      const interval = 1000 / frameCapRef.current;
      if (previousRender && now - previousRender < interval) return;
      const elapsed = previousRender ? Math.min(0.1, (now - previousRender) / 1000) : 0;
      previousRender = now - ((now - previousRender) % interval);
      if (elapsed > 0 && (camera.position.y > groundHeight || verticalVelocity > 0)) {
        verticalVelocity -= 19.5 * elapsed;
        camera.position.y += verticalVelocity * elapsed;
        if (camera.position.y <= groundHeight) {
          camera.position.y = groundHeight;
          verticalVelocity = 0;
          jumpsUsed = 0;
        }
      }
      const forwardInput = Number(movementKeys.has('w')) - Number(movementKeys.has('s'));
      const strafeInput = Number(movementKeys.has('d')) - Number(movementKeys.has('a'));
      const moveLength = Math.hypot(forwardInput, strafeInput);
      if (moveLength > 0 && elapsed > 0) {
        const forwardX = -Math.sin(yaw), forwardZ = -Math.cos(yaw);
        const rightX = Math.cos(yaw), rightZ = -Math.sin(yaw);
        const moveX = (forwardX * forwardInput + rightX * strafeInput) / moveLength;
        const moveZ = (forwardZ * forwardInput + rightZ * strafeInput) / moveLength;
        const walkSpeed = 4.2;
        camera.position.x = THREE.MathUtils.clamp(camera.position.x + moveX * walkSpeed * elapsed, -7, 7);
        camera.position.z = THREE.MathUtils.clamp(camera.position.z + moveZ * walkSpeed * elapsed, -5, 4);
      }
      for (const actor of actors) {
        if (!actor.moveStart) continue;
        const progress = Math.min(1, (now - actor.moveStart) / actor.moveDuration);
        const eased = progress * progress * (3 - 2 * progress);
        actor.group.position.lerpVectors(actor.from, actor.to, eased);
        actor.group.rotation.y = Math.sin(progress * Math.PI) * 0.08;
        if (progress >= 1) { actor.group.position.copy(actor.to); actor.moveStart = 0; actor.group.rotation.y = 0; }
      }
      if (boss) {
        boss.visible = bossHealthRef.current > 0;
        boss.position.y = 2.65 + Math.sin(now * 0.0017) * 0.18;
        boss.rotation.y = Math.sin(now * 0.0007) * 0.12;
      }
      for (let projectileIndex = game.projectiles.length - 1; projectileIndex >= 0; projectileIndex -= 1) {
        const projectile = game.projectiles[projectileIndex];
        const previousPosition = projectile.mesh.position.clone();
        projectile.mesh.position.addScaledVector(projectile.velocity, elapsed);
        projectile.age += elapsed;
        const playerUpperBody = camera.position.clone();
        playerUpperBody.y -= 0.35;
        const travelSegment = new THREE.Line3(previousPosition, projectile.mesh.position);
        const closestPoint = new THREE.Vector3();
        travelSegment.closestPointToPoint(playerUpperBody, true, closestPoint);
        const hitPlayer = closestPoint.distanceTo(playerUpperBody) < 0.8;
        if (hitPlayer) damagePlayerRef.current();
        if (hitPlayer || projectile.age > 8 || (boss && bossHealthRef.current <= 0)) {
          scene.remove(projectile.mesh);
          projectile.mesh.geometry.dispose();
          projectile.mesh.material.dispose();
          game.projectiles.splice(projectileIndex, 1);
        }
      }
      cyanLight.intensity = 22 + Math.sin(now * 0.001) * 2;
      renderer.render(scene, camera);
    };
    renderer.domElement.addEventListener('click', onCanvasClick);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('keydown', onMoveKeyDown);
    window.addEventListener('keyup', onMoveKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', resize);
    document.addEventListener('pointerlockchange', onPointerLock);
    game.frame = window.requestAnimationFrame(animate);

    return () => {
      window.cancelAnimationFrame(game.frame);
      renderer.domElement.removeEventListener('click', onCanvasClick);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('keydown', onMoveKeyDown);
      window.removeEventListener('keyup', onMoveKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', resize);
      document.removeEventListener('pointerlockchange', onPointerLock);
      if (document.pointerLockElement === renderer.domElement) document.exitPointerLock?.();
      actors.forEach((actor) => { actor.texture?.dispose(); actor.surface.geometry.dispose(); (actor.surface.material as THREE.Material).dispose(); });
      scene.traverse((object: THREE.Object3D) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material: THREE.Material) => material.dispose());
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
      gameRef.current = null;
      actorSurfacesRef.current = [];
    };
  }, [direction, bossFight]);

  useEffect(() => {
    if (!bossFight || gameOver) return;
    const interval = Math.max(1300, 4500 - bossDifficulty * 320);
    const pendingShots = new Set<number>();
    const timer = window.setInterval(() => {
      if (bossHealthRef.current <= 0 || gameOverRef.current) { window.clearInterval(timer); return; }
      if (!gameRef.current?.boss) return;
      const shotsInBurst = Math.min(8, 1 + Math.floor((bossDifficulty - 1) * 0.8));
      const spacingMs = Math.max(60, 190 - bossDifficulty * 13);
      for (let shot = 0; shot < shotsInBurst; shot += 1) {
        const timeout = window.setTimeout(() => {
          pendingShots.delete(timeout);
          const game = gameRef.current;
          if (game?.boss && bossHealthRef.current > 0 && !gameOverRef.current) launchBossProjectile(game, bossDifficulty);
        }, shot * spacingMs);
        pendingShots.add(timeout);
      }
    }, interval);
    return () => {
      window.clearInterval(timer);
      pendingShots.forEach((timeout) => window.clearTimeout(timeout));
    };
  }, [bossFight, gameOver, bossDifficulty]);

  // Update each target's canvas label when the question changes.
  useEffect(() => {
    if (!word) return;
    const actors = gameRef.current?.actors ?? [];
    actors.forEach((actor, index) => {
      const choice = choices[index];
      if (!choice) return;
      actor.texture?.dispose();
      const texture = makeTargetTexture(choice, direction, index);
      actor.texture = texture;
      const material = actor.surface.material;
      material.map = texture ?? null;
      material.needsUpdate = true;
      actor.surface.userData.targetIndex = index;
    });
  }, [choices, word, direction]);

  // Start a smooth 3D relocation toward a new set of spatial slots.
  useEffect(() => {
    const actors = gameRef.current?.actors;
    if (!actors?.length) return;
    actors.forEach((actor, index) => {
      const slot = slots[positions[index] ?? index];
      actor.from.copy(actor.group.position);
      actor.to.set(slot.x, slot.y, slot.z);
      actor.moveStart = performance.now();
      actor.moveDuration = Math.max(280, 1260 - movementSpeed * 95);
    });
  }, [positions, movementSpeed]);
  useEffect(() => {
    if (feedback || gameOver || choices.length < 2) return;
    const timer = window.setInterval(() => setPositions((previous) => newShuffle(previous)), swapSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [swapSeconds, feedback, gameOver, index, choices.length]);

  if (!cards.length) return <div className="fixed inset-0 z-[100] grid place-items-center bg-[#07111c] px-5 text-center text-white"><div><h1 className="font-serif text-3xl">No cards for this shooter round.</h1><p className="mt-3 text-white/65">Try another deck or discovery filter.</p><Link href="/quiz" className="mt-6 inline-flex items-center gap-2 rounded-xl border border-white/20 px-4 py-3"><ArrowLeft size={16} /> Back to setup</Link></div></div>;
  if (!word) return null;

  return <main className="fixed inset-0 z-[100] h-[100dvh] w-screen overflow-hidden bg-[#06111c] text-white" data-testid="aim-shooter-mode">
    <div ref={mountRef} className="absolute inset-0" />
    {webglError && <div className="absolute inset-0 z-50 grid place-items-center bg-[#06111c] p-6 text-center"><div><h2 className="text-2xl font-bold">3D mode needs WebGL</h2><p className="mt-3 text-sm text-white/70">This browser or device could not start hardware-accelerated 3D.</p><button onClick={() => setLocation('/quiz')} className="mt-5 rounded-xl border border-white/20 px-4 py-3 text-sm">Back to quiz setup</button></div></div>}
    <div className="pointer-events-none absolute inset-0 z-10 bg-[radial-gradient(ellipse_at_center,transparent_38%,rgba(0,0,0,.56)_100%)]" />
    <header data-shooter-ui className="absolute inset-x-0 top-0 z-40 flex items-start justify-between gap-3 p-3 sm:p-5">
      <div className="rounded-xl border border-cyan-100/15 bg-[#07111c]/75 px-3 py-2 shadow-lg backdrop-blur-md sm:px-4"><p className="text-[9px] font-black tracking-[.25em] text-cyan-100/55">WEBGL / 3D RANGE · {frameCap} FPS CAP</p><h1 className="mt-1 text-sm font-black tracking-[.12em] sm:text-base">{bossFight ? 'BOSS ENGAGEMENT' : 'MOVING TARGET DRILL'}</h1></div>
      <div className="flex items-center gap-2"><span className="rounded-xl border border-white/10 bg-black/50 px-3 py-2 text-xs font-black tabular-nums">{String(index + 1).padStart(2, '0')} / {String(cards.length).padStart(2, '0')}</span><span className="rounded-xl border border-white/10 bg-black/50 px-3 py-2 text-xs font-black"><Trophy size={14} className="mr-1 inline text-amber-300" />{answers.filter((item) => item.correct).length}</span><button onClick={() => { document.exitPointerLock?.(); setLocation('/quiz'); }} className="rounded-xl border border-white/15 bg-black/50 p-2.5 text-white/80 hover:text-white" aria-label="Exit shooter"><X size={16} /></button></div>
    </header>
    <section className="pointer-events-none absolute left-1/2 top-[78px] z-30 w-[min(760px,calc(100%-24px))] -translate-x-1/2 rounded-2xl border border-cyan-100/25 bg-[#081827]/85 px-4 py-3 text-center shadow-[0_12px_60px_rgba(0,0,0,.45)] backdrop-blur-md sm:top-[84px] sm:px-7 sm:py-4" data-testid="aim-stationary-question">
      <div className="flex items-center justify-between gap-2"><span className="text-[9px] font-black tracking-[.22em] text-cyan-100/55">MISSION / {word.level}</span><span className="text-[9px] font-black tracking-[.15em] text-cyan-100/70">{direction === 'meaning' ? 'SELECT THE MEANING' : direction === 'reading' ? 'SELECT THE READING' : 'SELECT THE JAPANESE WORD'}</span></div>
      <div className="mt-2 min-h-12">{direction === 'meaning' || direction === 'reading' ? <><p className="kanji-display text-3xl sm:text-4xl">{word.expression}</p>{direction === 'meaning' && <p className="mt-0.5 text-xs text-cyan-100/75">{word.reading}</p>}{direction === 'reading' && <p className="mt-0.5 text-[10px] text-white/45">Which reading is correct?</p>}</> : <><p className="mx-auto max-w-2xl text-lg font-bold leading-tight sm:text-2xl">{word.meaning}</p><p className="mt-1 text-[10px] text-white/45">Which Japanese word matches?</p></>}</div>
    </section>
    {bossFight && <section className="pointer-events-none absolute left-1/2 top-[205px] z-30 grid w-[min(620px,calc(100%-28px))] -translate-x-1/2 grid-cols-2 gap-2 rounded-xl border border-white/10 bg-[#06111c]/75 p-2.5 shadow-lg backdrop-blur-md" data-testid="boss-fight-hud">
      <div><div className="flex justify-between text-[9px] font-black tracking-[.12em]"><span className="text-rose-200">BOSS CORE</span><span>{bossHealth <= 0 ? 'DEFEATED' : `${bossHealth}/${cards.length} HP`}</span></div><div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-rose-500 transition-[width]" style={{ width: `${cards.length ? (bossHealth / cards.length) * 100 : 0}%` }} /></div><p className="mt-1 text-[8px] text-white/45">1 HP per correct answer · {answers.filter((item) => item.correct).length}/{cards.length} correct</p></div>
      <div><div className="flex justify-between text-[9px] font-black tracking-[.12em]"><span className="text-cyan-100">PLAYER SHIELD</span><span>{playerHealth}%</span></div><div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-cyan-400 transition-[width]" style={{ width: `${playerHealth}%` }} /></div></div>
    </section>}
    {control === 'aim' && <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-1/2 z-30 -translate-x-1/2 -translate-y-1/2"><Crosshair size={34} strokeWidth={1.5} className="text-lime-200 drop-shadow-[0_0_9px_rgba(190,242,100,.9)]" /></div>}
    {feedback && <div className={`pointer-events-none absolute inset-0 z-40 grid place-items-center text-4xl font-black tracking-[.2em] ${feedback === 'correct' ? 'text-emerald-300' : 'text-rose-300'}`}><span className="rounded-2xl border border-white/20 bg-black/65 px-8 py-5 shadow-xl">{feedback === 'correct' ? 'HIT!' : 'MISS'}</span></div>}
    {gameOver && <div className="absolute inset-0 z-[70] grid place-items-center bg-[#02060c]/85 p-6 text-center backdrop-blur-sm"><div className="max-w-sm rounded-2xl border border-rose-300/30 bg-[#101923] p-8 shadow-2xl"><p className="text-[10px] font-black tracking-[.25em] text-rose-300">BOSS ENCOUNTER</p><h2 className="mt-3 text-3xl font-black">SHIELD DOWN</h2><p className="mt-3 text-sm leading-6 text-white/65">The boss landed too many shots. You answered {answers.filter((item) => item.correct).length} correctly.</p><button onClick={() => setLocation('/quiz')} className="mt-6 rounded-xl border border-white/20 px-5 py-3 text-sm font-bold hover:bg-white/10">Return to setup</button></div></div>}
    <div className="absolute bottom-[100px] left-3 z-30 rounded-lg border border-white/10 bg-black/55 px-3 py-2 text-[9px] text-white/75 backdrop-blur sm:bottom-5 sm:left-5">{bossFight ? control === 'cursor' ? 'WASD MOVE · SPACE JUMP/DOUBLE · DODGE RED SHOTS · CLICK TARGET' : locked ? 'WASD MOVE · SPACE JUMP/DOUBLE · DODGE · MOUSE LOOK & FIRE' : 'WASD MOVE · SPACE JUMP/DOUBLE · CLICK RANGE TO AIM' : control === 'cursor' ? 'WASD MOVE · SPACE JUMP (PRESS AGAIN MID-AIR) · CLICK TARGET' : locked ? 'WASD MOVE · SPACE JUMP/DOUBLE · MOUSE LOOK · CLICK FIRE' : 'WASD MOVE · SPACE JUMP/DOUBLE · CLICK RANGE TO AIM'}</div>
    <footer data-shooter-ui className="absolute inset-x-0 bottom-0 z-40 flex flex-col gap-3 border-t border-white/10 bg-[#030a12]/90 p-3 backdrop-blur-md sm:flex-row sm:items-center sm:justify-between sm:px-5 sm:py-3">
      <div className="flex items-center gap-2"><span className="mr-1 text-[9px] font-black tracking-[.18em] text-white/45">CONTROL</span><button onClick={() => { document.exitPointerLock?.(); setControl('cursor'); }} aria-pressed={control === 'cursor'} className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[10px] font-bold ${control === 'cursor' ? 'border-cyan-200/50 bg-cyan-300/10 text-cyan-100' : 'border-white/15 text-white/65'}`}><MousePointer2 size={13} /> Cursor</button><button onClick={() => setControl('aim')} aria-pressed={control === 'aim'} className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[10px] font-bold ${control === 'aim' ? 'border-cyan-200/50 bg-cyan-300/10 text-cyan-100' : 'border-white/15 text-white/65'}`}><Crosshair size={13} /> FPS aim</button></div>
      <label className={`flex items-center gap-2 text-[10px] font-semibold ${control === 'aim' ? 'text-white/80' : 'text-white/40'}`}>Aim sensitivity <input aria-label="Aim sensitivity" type="range" min="0.2" max="2.5" step="0.1" value={sensitivity} disabled={control !== 'aim'} onChange={(event) => setSensitivity(Number(event.target.value))} className="w-24 accent-cyan-400" /><span className="w-7 font-mono">{sensitivity.toFixed(1)}×</span></label>
      <div className="flex items-center justify-between gap-3 text-[9px] text-white/45 sm:justify-end"><span>{bossFight ? 'Correct answers hurt the boss · dodge its red shots' : '3D target movement runs locally in your browser'}</span><button onClick={() => { document.exitPointerLock?.(); setLocation('/quiz'); }} className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-2.5 py-2 text-white/70 hover:text-white"><ArrowLeft size={12} /> Setup</button></div>
    </footer>
  </main>;
}
