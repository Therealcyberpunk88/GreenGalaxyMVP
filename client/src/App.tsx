/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Client, Room } from "colyseus.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { CSS2DRenderer, CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import "./App.css";

type ChatMsg = { id: string; name: string; text: string; ts: number };

const PLAYER_GROUND_Y = 0.5; // adjust if your env floor isn't exactly at y=0

const AVATARS = [
    { key: "a1", label: "Avatar 1", url: "https://models.readyplayer.me/693d32e914ff705000f2f3bc.glb" },
    { key: "a2", label: "Avatar 2", url: "https://models.readyplayer.me/693d37dab6235d0cd1787861.glb" },
    { key: "a3", label: "Avatar 3", url: "https://models.readyplayer.me/693d37f4100ae875d57e08ab.glb" },
] as const;

const ENVIRONMENTS = [
    {
        key: "office",
        label: "Office",
        glb: "/environments/office.glb",
        colliders: "/environments/office_colliders.glb",
        thumb: "/env-previews/office.png",
    },
    {
        key: "whitespace",
        label: "Whitespace",
        glb: "/environments/whitespace.glb",
        colliders: "/environments/whitespace_colliders.glb",
        thumb: "/env-previews/whitespace.png",
    },
] as const;

type AvatarKey = (typeof AVATARS)[number]["key"];
type EnvKey = (typeof ENVIRONMENTS)[number]["key"];
type AnimKey = "idle" | "walk" | "wave";

type PlayerRig = {
    root: THREE.Group;
    model: THREE.Object3D;
    mixer: THREE.AnimationMixer;
    actions: Record<AnimKey, THREE.AnimationAction>;
    current: AnimKey;

    targetPos: THREE.Vector3;
    targetYaw: number;

    emoteActive: boolean;

    label: CSS2DObject;
};

export default function App() {
    const mountRef = useRef<HTMLDivElement | null>(null);
    const hudRef = useRef<HTMLDivElement | null>(null);

    const [connected, setConnected] = useState(false);
    const [name, setName] = useState("Guest");
    const [avatarKey, setAvatarKey] = useState<AvatarKey>("a1");
    const [envKey, setEnvKey] = useState<EnvKey>("office");

    const [cameraMode, setCameraMode] = useState<"third" | "first">("third");
    const cameraModeRef = useRef<"third" | "first">("third");
    useEffect(() => {
        cameraModeRef.current = cameraMode;
    }, [cameraMode]);

    const [chat, setChat] = useState<ChatMsg[]>([]);
    const [chatInput, setChatInput] = useState("");
    const [myId, setMyId] = useState("");

    const client = useMemo(() => new Client("ws://localhost:2567"), []);
    const roomRef = useRef<Room | null>(null);
    const myIdRef = useRef<string>("");

    useEffect(() => {
        myIdRef.current = myId;
    }, [myId]);

    // ---------- input ----------
    const keysRef = useRef<Record<string, boolean>>({});
    useEffect(() => {
        const down = (e: KeyboardEvent) => (keysRef.current[e.key.toLowerCase()] = true);
        const up = (e: KeyboardEvent) => (keysRef.current[e.key.toLowerCase()] = false);
        window.addEventListener("keydown", down);
        window.addEventListener("keyup", up);
        return () => {
            window.removeEventListener("keydown", down);
            window.removeEventListener("keyup", up);
        };
    }, []);

    // leave best-effort on refresh/close
    useEffect(() => {
        const handler = () => {
            try {
                roomRef.current?.leave();
            } catch { }
        };
        window.addEventListener("beforeunload", handler);
        return () => window.removeEventListener("beforeunload", handler);
    }, []);

    // ---------- orbit camera ----------
    const camRef = useRef({ yaw: 0, pitch: -0.25, dist: 6, lmbDown: false });

    // ---------- loaders + caches ----------
    const gltfLoaderRef = useRef(new GLTFLoader());
    const avatarCacheRef = useRef(new Map<AvatarKey, THREE.Object3D>());
    const clipCacheRef = useRef(new Map<AnimKey, THREE.AnimationClip>());

    const envCacheRef = useRef(new Map<EnvKey, THREE.Object3D>());
    const envMountedRef = useRef<{ key: EnvKey | null; obj: THREE.Object3D | null }>({ key: null, obj: null });

    // colliders
    const colliderObjRef = useRef<THREE.Object3D | null>(null);
    const colliderBoxesRef = useRef<THREE.Box3[]>([]);

    // ---------- three state ----------
    const threeRef = useRef<{
        scene: THREE.Scene;
        camera: THREE.PerspectiveCamera;
        renderer: THREE.WebGLRenderer;
        labelRenderer: CSS2DRenderer;
        clock: THREE.Clock;
        rigs: Map<string, PlayerRig>;
    } | null>(null);

    const stateBoundRef = useRef(false);

    // ---------- helpers ----------
    function computeBox(obj: THREE.Object3D): THREE.Box3 {
        return new THREE.Box3().setFromObject(obj);
    }

    function autoScaleToHuman(obj: THREE.Object3D, targetHeight = 1.7) {
        const box = computeBox(obj);
        const h = box.max.y - box.min.y;
        if (!Number.isFinite(h) || h <= 0.0001) return;
        if (h > 4 || h < 0.7) obj.scale.multiplyScalar(targetHeight / h);
    }

    function computeFeetOffset(obj: THREE.Object3D): number {
        const box = computeBox(obj);
        const minY = box.min.y;
        if (!Number.isFinite(minY)) return 0;
        return -minY;
    }

    function disposeObject(obj: THREE.Object3D) {
        obj.traverse((o: any) => {
            if (o?.geometry) o.geometry.dispose?.();
            if (o?.material) {
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach((m: any) => {
                    if (!m) return;
                    for (const k of ["map", "normalMap", "metalnessMap", "roughnessMap", "emissiveMap", "aoMap"]) {
                        if (m[k]) m[k].dispose?.();
                    }
                    m.dispose?.();
                });
            }
        });
    }

    function isBlocked(nextPos: THREE.Vector3): boolean {
        const radius = 0.45;

        // sample at a fixed height above ground (hips-ish), independent of drifting y
        const p = new THREE.Vector3(nextPos.x, PLAYER_GROUND_Y + 1.0, nextPos.z);

        for (const b of colliderBoxesRef.current) {
            const expanded = b.clone().expandByScalar(radius);
            if (expanded.containsPoint(p)) return true;
        }
        return false;
    }


    async function loadEnvironment(key: EnvKey) {
        if (!threeRef.current) return;

        // remove current env
        if (envMountedRef.current.obj) {
            threeRef.current.scene.remove(envMountedRef.current.obj);
            disposeObject(envMountedRef.current.obj);
            envMountedRef.current.obj = null;
            envMountedRef.current.key = null;
        }

        // remove colliders
        if (colliderObjRef.current) {
            threeRef.current.scene.remove(colliderObjRef.current);
            disposeObject(colliderObjRef.current);
            colliderObjRef.current = null;
        }
        colliderBoxesRef.current = [];

        const def = ENVIRONMENTS.find((e) => e.key === key)!;

        // load/cache env base
        let base = envCacheRef.current.get(key);
        if (!base) {
            const gltf = await gltfLoaderRef.current.loadAsync(def.glb);
            base = gltf.scene;
            base.traverse((o: any) => {
                if (o?.isMesh) o.frustumCulled = false;
            });
            envCacheRef.current.set(key, base);
        }

        // clone for scene
        const env = base.clone(true);

        // center env on origin
        const box = new THREE.Box3().setFromObject(env);
        const center = box.getCenter(new THREE.Vector3());
        env.position.sub(center);

        // put floor on y=-0
        const box2 = new THREE.Box3().setFromObject(env);
        env.position.y -= box2.min.y;
        env.position.y -= 0.3; // ✅ lower the whole environment by 1m

        threeRef.current.scene.add(env);
        envMountedRef.current = { key, obj: env };

        // ---- colliders ----
        const colGltf = await gltfLoaderRef.current.loadAsync(def.colliders);
        const col = colGltf.scene;

        col.position.copy(env.position);
        col.rotation.copy(env.rotation);
        col.scale.copy(env.scale);

        col.traverse((o: any) => {
            if (o?.isMesh) {
                o.visible = false;
                o.frustumCulled = false;
            }
        });

        threeRef.current.scene.add(col);
        colliderObjRef.current = col;

        col.updateMatrixWorld(true);
        const boxes: THREE.Box3[] = [];

        const tempBox = new THREE.Box3();
        const tempMat = new THREE.Matrix4();

        col.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!(m as any).isMesh) return;
            if (!m.geometry) return;

            // ensure geometry bounding box exists
            if (!m.geometry.boundingBox) {
                m.geometry.computeBoundingBox();
            }
            if (!m.geometry.boundingBox) return;

            // start from geometry local bounds
            tempBox.copy(m.geometry.boundingBox);

            // transform local bounds into world AABB
            tempMat.copy(m.matrixWorld);
            tempBox.applyMatrix4(tempMat);

            if (Number.isFinite(tempBox.min.x)) {
                boxes.push(tempBox.clone());
                const shrink = 0.05;
                tempBox.min.x += shrink;
                tempBox.min.z += shrink;
                tempBox.max.x -= shrink;
                tempBox.max.z -= shrink;
            }
        });

        colliderBoxesRef.current = boxes;
        console.log("🧱 Collider boxes:", boxes.length);


        colliderBoxesRef.current = boxes;
        console.log("🧱 Colliders loaded:", boxes.length, "env:", key);
    }

    async function loadAvatarBase(key: AvatarKey): Promise<THREE.Object3D> {
        const cached = avatarCacheRef.current.get(key);
        if (cached) return cached;

        const url = AVATARS.find((a) => a.key === key)!.url;
        const gltf = await gltfLoaderRef.current.loadAsync(url);

        const base = gltf.scene;
        base.traverse((o: any) => {
            if (o?.isMesh) o.frustumCulled = false;
        });

        avatarCacheRef.current.set(key, base);
        return base;
    }

    async function loadClip(anim: AnimKey): Promise<THREE.AnimationClip> {
        const cached = clipCacheRef.current.get(anim);
        if (cached) return cached;

        const path =
            anim === "idle"
                ? "/rpm-animations/Idle.glb"
                : anim === "walk"
                    ? "/rpm-animations/Walk.glb"
                    : "/rpm-animations/Wave.glb";

        const gltf = await gltfLoaderRef.current.loadAsync(path);
        if (!gltf.animations || gltf.animations.length === 0) throw new Error(`No animations in ${path}`);

        const clip = gltf.animations[0];
        clip.name = anim;
        clipCacheRef.current.set(anim, clip);
        return clip;
    }

    function setBaseAnim(rig: PlayerRig, next: "idle" | "walk") {
        if (rig.emoteActive) return;
        if (rig.current === next) return;

        const prev = rig.actions[rig.current];
        const nxt = rig.actions[next];

        nxt.reset().setLoop(THREE.LoopRepeat, Infinity).play();
        nxt.fadeIn(0.12);
        prev.fadeOut(0.12);

        rig.current = next;
    }

    function playWave(rig: PlayerRig) {
        if (rig.emoteActive) return;
        rig.emoteActive = true;

        rig.actions.idle.fadeOut(0.08);
        rig.actions.walk.fadeOut(0.08);

        const wave = rig.actions.wave;
        wave.enabled = true;
        wave.setEffectiveTimeScale(1);
        wave.setEffectiveWeight(1);
        wave.stop();
        wave.reset();
        wave.setLoop(THREE.LoopOnce, 1);
        wave.clampWhenFinished = true;
        wave.fadeIn(0.05).play();

        const onFinished = (e: any) => {
            if (e.action !== wave) return;
            rig.mixer.removeEventListener("finished", onFinished);

            rig.emoteActive = false;
            rig.actions.wave.fadeOut(0.08);
            rig.actions.idle.reset().fadeIn(0.12).play();
            rig.current = "idle";
        };

        rig.mixer.addEventListener("finished", onFinished);
    }

    async function ensureRig(playerId: string, key: AvatarKey): Promise<PlayerRig | null> {
        if (!threeRef.current) return null;

        const existing = threeRef.current.rigs.get(playerId);
        if (existing) return existing;

        const [base, idleClip, walkClip, waveClip] = await Promise.all([
            loadAvatarBase(key),
            loadClip("idle"),
            loadClip("walk"),
            loadClip("wave"),
        ]);

        const model = skeletonClone(base) as THREE.Object3D;

        autoScaleToHuman(model, 1.7);
        const feetOffset = computeFeetOffset(model);
        model.position.set(0, feetOffset, 0);

        const root = new THREE.Group();
        root.add(model);

        // ✅ nametag
        const div = document.createElement("div");
        div.className = "nametag";
        div.textContent = "…";
        const label = new CSS2DObject(div);
        label.position.set(0, 2.05, 0);
        root.add(label);

        const mixer = new THREE.AnimationMixer(model);

        const actions: Record<AnimKey, THREE.AnimationAction> = {
            idle: mixer.clipAction(idleClip),
            walk: mixer.clipAction(walkClip),
            wave: mixer.clipAction(waveClip),
        };

        actions.idle.reset().setLoop(THREE.LoopRepeat, Infinity).play();

        const rig: PlayerRig = {
            root,
            model,
            mixer,
            actions,
            current: "idle",
            targetPos: new THREE.Vector3(0, 0, 0),
            targetYaw: 0,
            emoteActive: false,
            label,
        };

        threeRef.current.scene.add(root);
        threeRef.current.rigs.set(playerId, rig);
        return rig;
    }

    function removeRig(playerId: string) {
        if (!threeRef.current) return;
        const rig = threeRef.current.rigs.get(playerId);
        if (!rig) return;
        threeRef.current.scene.remove(rig.root);
        rig.mixer.stopAllAction();
        threeRef.current.rigs.delete(playerId);
    }

    // ---------- init three ----------
    useEffect(() => {
        const mountEl = mountRef.current;
        if (!mountEl) return;

        mountEl.innerHTML = "";

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0b0f14);

        const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1200);

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.domElement.style.position = "absolute";
        renderer.domElement.style.inset = "0";
        renderer.domElement.style.width = "100%";
        renderer.domElement.style.height = "100%";
        renderer.domElement.style.display = "block";
        mountEl.appendChild(renderer.domElement);

        // ✅ label renderer (nametags)
        const labelRenderer = new CSS2DRenderer();
        labelRenderer.domElement.style.position = "absolute";
        labelRenderer.domElement.style.top = "0";
        labelRenderer.domElement.style.left = "0";
        labelRenderer.domElement.style.width = "100%";
        labelRenderer.domElement.style.height = "100%";
        labelRenderer.domElement.style.pointerEvents = "none";
        mountEl.appendChild(labelRenderer.domElement);

        scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.2));
        const dir = new THREE.DirectionalLight(0xffffff, 0.6);
        dir.position.set(5, 10, 3);
        scene.add(dir);

        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(500, 500),
            new THREE.MeshStandardMaterial({ color: 0x101826 })
        );
        ground.rotation.x = -Math.PI / 2;
        scene.add(ground);
        scene.add(new THREE.GridHelper(80, 80, 0x2a3a55, 0x1b273a));

        threeRef.current = {
            scene,
            camera,
            renderer,
            labelRenderer,
            clock: new THREE.Clock(),
            rigs: new Map(),
        };

        const resize = () => {
            if (!threeRef.current) return;
            const w = mountEl.clientWidth;
            const h = mountEl.clientHeight;
            if (w <= 0 || h <= 0) return;

            threeRef.current.camera.aspect = w / h;
            threeRef.current.camera.updateProjectionMatrix();
            threeRef.current.renderer.setSize(w, h, false);
            threeRef.current.labelRenderer.setSize(w, h);
        };

        const dom = renderer.domElement;

        const onMouseDown = (e: MouseEvent) => {
            if (e.button === 0) camRef.current.lmbDown = true;
        };
        const onMouseUp = (e: MouseEvent) => {
            if (e.button === 0) camRef.current.lmbDown = false;
        };
        const onMouseMove = (e: MouseEvent) => {
            if (!camRef.current.lmbDown) return;
            const sens = 0.004;
            camRef.current.yaw += e.movementX * sens;
            camRef.current.pitch -= e.movementY * sens;
            camRef.current.pitch = Math.max(-0.85, Math.min(0.35, camRef.current.pitch));
        };
        const onWheel = (e: WheelEvent) => {
            if (cameraModeRef.current === "first") return;
            camRef.current.dist += e.deltaY * 0.01;
            camRef.current.dist = Math.max(4.5, Math.min(18, camRef.current.dist));
        };

        dom.addEventListener("mousedown", onMouseDown);
        window.addEventListener("mouseup", onMouseUp);
        window.addEventListener("mousemove", onMouseMove);
        dom.addEventListener("wheel", onWheel, { passive: true });

        resize();
        window.addEventListener("resize", resize);

        let raf = 0;
        const animate = () => {
            raf = requestAnimationFrame(animate);
            if (!threeRef.current) return;

            resize();
            const dt = threeRef.current.clock.getDelta();

            for (const [id, rig] of threeRef.current.rigs) {
                rig.mixer.update(dt);

                if (id !== myIdRef.current) {
                    rig.root.position.lerp(rig.targetPos, 0.25);
                    rig.root.rotation.y = THREE.MathUtils.lerp(rig.root.rotation.y, rig.targetYaw, 0.25);
                }
            }

            const meId = myIdRef.current;
            const me = meId ? threeRef.current.rigs.get(meId) : null;

            if (me) {
                // hide local model + label in first-person
                const fp = cameraModeRef.current === "first";
                me.model.visible = !fp;
                me.label.visible = !fp;
                // 🔒 lock local player's Y so we never drift into the floor collider
                me.root.position.y = PLAYER_GROUND_Y;


                const k = keysRef.current;

                const forwardInput = (k["w"] ? 1 : 0) + (k["s"] ? -1 : 0);
                const strafeInput = (k["d"] ? 1 : 0) + (k["a"] ? -1 : 0);

                const yaw = camRef.current.yaw;

                const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)).normalize();
                const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)).normalize();

                const speed = 6.8;
                let moved = false;

                if (forwardInput !== 0 || strafeInput !== 0) {
                    const move = new THREE.Vector3()
                        .addScaledVector(forward, forwardInput)
                        .addScaledVector(right, strafeInput);

                    if (move.lengthSq() > 0) {
                        move.normalize().multiplyScalar(speed * dt);

                        const proposed = me.root.position.clone();
                        proposed.x += move.x;
                        proposed.z += move.z;

                        if (!isBlocked(proposed)) {
                            me.root.position.copy(proposed);
                            me.root.position.y = PLAYER_GROUND_Y;

                            const faceYaw = Math.atan2(move.x, move.z);
                            me.root.rotation.y = faceYaw;

                            moved = true;
                            if (!me.emoteActive) setBaseAnim(me, "walk");

                            roomRef.current?.send("move", {
                                x: me.root.position.x,
                                y: PLAYER_GROUND_Y,
                                z: me.root.position.z,
                                ry: faceYaw,
                            });
                        }
                    }
                }

                if (!moved && !me.emoteActive) setBaseAnim(me, "idle");

                // ----- camera -----
                const yawC = camRef.current.yaw;
                const pitchC = camRef.current.pitch;

                if (fp) {
                    const head = new THREE.Vector3(me.root.position.x, me.root.position.y + 1.65, me.root.position.z);

                    const dirLook = new THREE.Vector3(
                        -Math.sin(yawC) * Math.cos(pitchC),
                        Math.sin(pitchC),
                        -Math.cos(yawC) * Math.cos(pitchC)
                    ).normalize();

                    const lookAt = head.clone().add(dirLook);

                    threeRef.current.camera.position.lerp(head, 0.35);
                    threeRef.current.camera.lookAt(lookAt);
                } else {
                    const target = new THREE.Vector3(me.root.position.x, me.root.position.y + 1.6, me.root.position.z);
                    const dist = camRef.current.dist;

                    const offset = new THREE.Vector3(
                        Math.sin(yawC) * Math.cos(pitchC),
                        Math.sin(pitchC),
                        Math.cos(yawC) * Math.cos(pitchC)
                    ).multiplyScalar(dist);

                    const desiredCam = target.clone().add(offset);
                    desiredCam.y = Math.max(me.root.position.y + 1.6, desiredCam.y);

                    threeRef.current.camera.position.lerp(desiredCam, 0.18);
                    threeRef.current.camera.lookAt(target);
                }

                if (hudRef.current) {
                    hudRef.current.textContent = `cam:${cameraModeRef.current} | env:${envMountedRef.current.key ?? "-"} | colliders:${colliderBoxesRef.current.length
                        } | players:${threeRef.current.rigs.size} | LMB orbit | WASD move`;
                }
            }

            threeRef.current.renderer.render(threeRef.current.scene, threeRef.current.camera);
            threeRef.current.labelRenderer.render(threeRef.current.scene, threeRef.current.camera);
        };

        animate();

        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener("resize", resize);

            dom.removeEventListener("mousedown", onMouseDown);
            window.removeEventListener("mouseup", onMouseUp);
            window.removeEventListener("mousemove", onMouseMove);
            dom.removeEventListener("wheel", onWheel as any);

            renderer.dispose();
            mountEl.removeChild(renderer.domElement);
            mountEl.removeChild(labelRenderer.domElement);
            threeRef.current = null;
        };
    }, []);

    // ---------- join & networking ----------
    const join = async () => {
        const r = await client.joinOrCreate("my_room", { name, avatarKey, envKey });
        roomRef.current = r;
        myIdRef.current = r.sessionId;

        setMyId(r.sessionId);
        setConnected(true);

        // ✅ Load env immediately (prevents "appears after first move")
        const initialEnv = ((r.state as any)?.envKey as EnvKey) ?? envKey;
        if (envMountedRef.current.key !== initialEnv) {
            loadEnvironment(initialEnv).catch((e) => console.error("ENV INIT LOAD ERROR", e));
        }

        r.onMessage("chat", (msg: ChatMsg) => setChat((prev) => [...prev, msg].slice(-200)));

        r.onMessage("emote", (data: { id: string; emote: string }) => {
            if (!threeRef.current) return;
            const rig = threeRef.current.rigs.get(data.id);
            if (!rig) return;
            if (data.emote === "wave") playWave(rig);
        });

        // create local rig immediately
        await ensureRig(r.sessionId, avatarKey);
        const myRig = threeRef.current?.rigs.get(r.sessionId);
        if (myRig) myRig.label.element.textContent = name;

        r.onStateChange((state: any) => {
            if (!state) return;

            const newEnv: EnvKey = (state.envKey as EnvKey) || "office";
            if (envMountedRef.current.key !== newEnv) {
                loadEnvironment(newEnv).catch((e) => console.error("ENV LOAD ERROR", e));
            }

            if (!state.players) return;
            const players = state.players;

            if (!stateBoundRef.current && typeof players.onAdd === "function") {
                stateBoundRef.current = true;

                players.onAdd(async (p: any, id: string) => {
                    const key: AvatarKey = (p?.avatarKey as AvatarKey) || "a1";
                    const rig = await ensureRig(id, key);
                    if (!rig) return;

                    rig.label.element.textContent = (p?.name ?? "Guest").toString();

                    rig.root.position.set(p?.x ?? 0, p?.y ?? 0, p?.z ?? 0);
                    rig.root.rotation.y = p?.ry ?? 0;
                    rig.targetPos.set(p?.x ?? 0, p?.y ?? 0, p?.z ?? 0);
                    rig.targetYaw = p?.ry ?? 0;

                    if (p && typeof p.onChange === "function") {
                        p.onChange = () => {
                            if (!threeRef.current) return;
                            const rr = threeRef.current.rigs.get(id);
                            if (!rr) return;
                            if (id === myIdRef.current) return;

                            rr.targetPos.set(p?.x ?? 0, p?.y ?? 0, p?.z ?? 0);
                            rr.targetYaw = p?.ry ?? 0;
                        };
                    }
                });

                players.onRemove((_p: any, id: string) => removeRig(id));
            }

            // catch-up existing
            players.forEach(async (p: any, id: string) => {
                const key: AvatarKey = (p?.avatarKey as AvatarKey) || "a1";
                const rig = await ensureRig(id, key);
                if (!rig) return;

                rig.label.element.textContent = (p?.name ?? "Guest").toString();

                if (id !== myIdRef.current) {
                    rig.targetPos.set(p?.x ?? 0, p?.y ?? 0, p?.z ?? 0);
                    rig.targetYaw = p?.ry ?? 0;
                } else {
                    rig.root.position.set(p?.x ?? 0, PLAYER_GROUND_Y, p?.z ?? 0);
                    rig.targetPos.set(p?.x ?? 0, PLAYER_GROUND_Y, p?.z ?? 0);
                }
            });
        });
    };

    const sendChat = () => {
        const r = roomRef.current;
        if (!r) return;
        const text = chatInput.trim();
        if (!text) return;
        r.send("chat", { text });
        setChatInput("");
    };

    const wave = () => {
        const r = roomRef.current;
        const id = myIdRef.current;
        if (!r || !threeRef.current || !id) return;

        const rig = threeRef.current.rigs.get(id);
        if (!rig) return;

        playWave(rig);
        r.send("emote", { emote: "wave" });
    };

    return (
        <div className="app">
            <div className="canvas" ref={mountRef} />

            <div
                ref={hudRef}
                style={{
                    position: "absolute",
                    left: 12,
                    bottom: 12,
                    padding: "8px 10px",
                    background: "rgba(0,0,0,0.55)",
                    color: "white",
                    fontFamily: "monospace",
                    fontSize: 12,
                    borderRadius: 10,
                    zIndex: 5,
                }}
            >
                Loading…
            </div>

            <div className="ui">
                {!connected ? (
                    <div className="card">
                        <div className="title">GreenGalaxy Prototype</div>

                        <div className="row">
                            <label>Name</label>
                            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
                        </div>

                        <div className="row">
                            <label>Choose Avatar</label>
                            <div style={{ display: "grid", gap: 8 }}>
                                {AVATARS.map((a) => (
                                    <label key={a.key} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                        <input
                                            type="radio"
                                            name="avatar"
                                            checked={avatarKey === a.key}
                                            onChange={() => setAvatarKey(a.key)}
                                        />
                                        <span>{a.label}</span>
                                    </label>
                                ))}
                            </div>
                        </div>

                        <div className="row">
                            <label>Choose Environment</label>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                                {ENVIRONMENTS.map((e) => (
                                    <button
                                        key={e.key}
                                        onClick={() => setEnvKey(e.key)}
                                        style={{
                                            borderRadius: 12,
                                            border: envKey === e.key ? "2px solid #7dd3fc" : "1px solid rgba(255,255,255,0.15)",
                                            padding: 8,
                                            background: "rgba(0,0,0,0.25)",
                                            color: "white",
                                            cursor: "pointer",
                                            textAlign: "left",
                                        }}
                                    >
                                        <img
                                            src={e.thumb}
                                            alt={e.label}
                                            style={{
                                                width: "100%",
                                                height: 90,
                                                objectFit: "cover",
                                                borderRadius: 10,
                                                display: "block",
                                            }}
                                            onError={() => console.warn("Missing thumbnail:", e.thumb)}
                                        />
                                        <div style={{ marginTop: 8, fontWeight: 600 }}>{e.label}</div>
                                    </button>
                                ))}
                            </div>
                        </div>

                        <button onClick={join}>Join Space</button>
                        <div className="hint">LMB orbit • Wheel zoom • WASD move</div>
                    </div>
                ) : (
                    <div className="hud">
                        <div className="badge">
                            Connected as {name} ({myId.slice(0, 6)})
                        </div>

                        <div style={{ display: "flex", gap: 8 }}>
                            <button onClick={wave}>👋 Wave</button>
                            <button onClick={() => setCameraMode((m) => (m === "third" ? "first" : "third"))}>
                                {cameraMode === "third" ? "🎥 1st person" : "🎥 3rd person"}
                            </button>
                        </div>

                        <div className="chat">
                            <div className="chatlog">
                                {chat.map((m) => (
                                    <div key={m.ts + m.id}>
                                        <strong>{m.name}:</strong> {m.text}
                                    </div>
                                ))}
                            </div>

                            <div className="chatbar">
                                <input
                                    value={chatInput}
                                    onChange={(e) => setChatInput(e.target.value)}
                                    onKeyDown={(e) => e.key === "Enter" && sendChat()}
                                    placeholder="Type message…"
                                />
                                <button onClick={sendChat}>Send</button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
