// Содержимое, анимации и свет настраиваются в ar-config.json рядом с index.html.
;(function () {
  const CONFIG_URL = 'ar-config.json'
  const canvas = document.getElementById('canvas')
  const overlay = document.getElementById('loading')
  const status = document.getElementById('status')
  const states = new Map()
  let config, scene, clock, selected = null, foundSequence = 0, fatal = false
  let started = false

  function message(text, busy = false, error = false) {
    if (fatal) return
    status.textContent = text
    overlay.hidden = !text
    overlay.classList.toggle('busy', busy)
    overlay.classList.toggle('error', error)
  }

  function fail(error) {
    console.error(error)
    message('Ошибка: ' + (error?.message || String(error)), false, true)
    fatal = true
  }

  function finite(value, fallback, label, min = -Infinity) {
    const result = value === undefined ? fallback : value
    if (typeof result !== 'number' || !Number.isFinite(result) || result < min) {
      throw new Error(label + ': требуется число' + (min > -Infinity ? ' не меньше ' + min : ''))
    }
    return result
  }

  function boolean(value, fallback, label) {
    if (value === undefined) return fallback
    if (typeof value !== 'boolean') throw new Error(label + ': требуется true или false')
    return value
  }

  function vector(value, fallback, label) {
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
      throw new Error(label + ': требуется объект с x, y, z')
    }
    return Object.fromEntries(['x', 'y', 'z'].map(axis =>
      [axis, finite(value?.[axis], fallback[axis], label + '.' + axis)]))
  }

  function color(value, fallback, label) {
    const result = value === undefined ? fallback : value
    if (typeof result !== 'string' || !/^#[\da-f]{6}$/i.test(result)) {
      throw new Error(label + ': используйте цвет вида #ffffff')
    }
    return result
  }

  function text(value, label) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(label + ': требуется непустая строка')
    return value.trim()
  }

  function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(label + ': требуется объект')
    }
    return value
  }

  function validate(raw) {
    object(raw, CONFIG_URL)
    if (raw.version !== 2) throw new Error('ar-config.json: требуется "version": 2')
    const mode = raw.displayMode ?? 'multiple'
    if (!['multiple', 'single'].includes(mode)) throw new Error('displayMode: используйте multiple или single')
    if (!Array.isArray(raw.items)) throw new Error('items: требуется список моделей')
    const items = raw.items.flatMap((value, index) => {
      const label = 'items[' + index + ']'
      const item = object(value, label)
      if (!boolean(item.enabled, true, label + '.enabled')) return []
      const animation = object(item.animation ?? {}, label + '.animation')
      const clip = animation.clip ?? 0
      if (!(typeof clip === 'string' && clip.length) && !(Number.isInteger(clip) && clip >= 0)) {
        throw new Error(label + '.animation.clip: требуется номер с нуля или имя анимации')
      }
      const size = finite(item.size, 0.65, label + '.size', 0)
      if (!size) throw new Error(label + '.size должен быть больше нуля')
      return [{
        label: item.label === undefined ? 'Модель ' + (index + 1) : text(item.label, label + '.label'),
        targetJson: text(item.targetJson, label + '.targetJson'),
        modelUrl: text(item.modelUrl, label + '.modelUrl'), size,
        rotationDegrees: vector(item.rotationDegrees, {x: 90, y: 0, z: 0}, label + '.rotationDegrees'),
        offset: vector(item.offset, {x: 0, y: 0, z: 0}, label + '.offset'),
        animation: {
          enabled: boolean(animation.enabled, true, label + '.animation.enabled'), clip,
          speed: finite(animation.speed, 1, label + '.animation.speed', 0),
          loop: boolean(animation.loop, true, label + '.animation.loop'),
          restartOnFound: boolean(animation.restartOnFound, false, label + '.animation.restartOnFound'),
        },
      }]
    })
    if (!items.length) throw new Error('В items нет включённых моделей (enabled: true)')
    const paths = items.map(item => new URL(item.targetJson, document.baseURI).href)
    if (new Set(paths).size !== paths.length) throw new Error('В items повторяется путь targetJson')

    const lights = object(raw.lighting ?? {}, 'lighting')
    const ambient = object(lights.ambient ?? {}, 'lighting.ambient')
    const hemi = object(lights.hemisphere ?? {}, 'lighting.hemisphere')
    const directional = lights.directional ?? [
      {color: '#ffffff', intensity: 0.8, position: {x: 1, y: 2, z: 3}},
    ]
    if (!Array.isArray(directional)) throw new Error('lighting.directional: требуется список источников')
    return {
      displayMode: mode,
      preloadModels: boolean(raw.preloadModels, false, 'preloadModels'), items,
      lighting: {
        ambient: {
          color: color(ambient.color, '#ffffff', 'lighting.ambient.color'),
          intensity: finite(ambient.intensity, 0, 'lighting.ambient.intensity', 0),
        },
        hemisphere: {
          skyColor: color(hemi.skyColor, '#ffffff', 'lighting.hemisphere.skyColor'),
          groundColor: color(hemi.groundColor, '#666666', 'lighting.hemisphere.groundColor'),
          intensity: finite(hemi.intensity, 1.2, 'lighting.hemisphere.intensity', 0),
        },
        directional: directional.map((value, index) => {
          const key = 'lighting.directional[' + index + ']'
          const light = object(value, key)
          return {
            color: color(light.color, '#ffffff', key + '.color'),
            intensity: finite(light.intensity, 0.8, key + '.intensity', 0),
            position: vector(light.position, {x: 1, y: 2, z: 3}, key + '.position'),
            target: vector(light.target, {x: 0, y: 0, z: 0}, key + '.target'),
          }
        }),
      },
    }
  }

  async function json(path, label) {
    const url = new URL(path, document.baseURI)
    const response = await fetch(url, {cache: 'no-store'})
    if (!response.ok) throw new Error(label + ': HTTP ' + response.status + ' — ' + url.pathname)
    try { return {data: await response.json(), url} }
    catch { throw new Error(label + ': некорректный JSON — ' + url.pathname) }
  }

  async function addTarget(item) {
    const {data, url} = await json(item.targetJson, item.label)
    const name = text(data.name, item.targetJson + ': name')
    if (data.type !== 'PLANAR') throw new Error(item.label + ': этот шаблон поддерживает плоские маркеры (flat)')
    if (states.has(name)) throw new Error('Повторяется имя маркера "' + name + '". Сгенерируйте цели с разными именами')
    if (typeof data.imagePath !== 'string' || !data.imagePath) throw new Error(item.targetJson + ': отсутствует imagePath')
    if (!data.properties || typeof data.properties !== 'object') throw new Error(item.targetJson + ': отсутствует properties')
    data.imagePath = data.resources?.luminanceImage
      ? new URL(data.resources.luminanceImage, url).href
      : new URL(data.imagePath, document.baseURI).href
    states.set(name, {name, item, data, anchor: null, content: null, mixer: null, action: null,
      tracked: false, lastFound: 0, pose: null, promise: null, error: null})
  }

  function eligible(state) {
    return state.tracked && (config.displayMode === 'multiple' || selected === state)
  }

  function refresh() {
    if (!scene || fatal) return
    const active = [...states.values()].filter(eligible)
    for (const state of states.values()) {
      if (state.anchor) state.anchor.visible = eligible(state) && !!state.content
    }
    const pending = active.filter(state => state.promise && !state.content && !state.error)
    if (pending.length) message('Загрузка: ' + pending.map(s => s.item.label).join(', ') + '…', true)
    else if (active.some(state => state.content)) message('')
    else if (active.some(state => state.error)) {
      const state = active.find(s => s.error)
      message(state.item.label + ': ' + state.error + '. Исправьте файл и обновите страницу', false, true)
    } else message('Наведите камеру на маркер')
  }

  function applyPose(state) {
    if (!state.anchor || !state.pose) return
    const pose = state.pose
    const shorter = Math.min(pose.scaledWidth || 1, pose.scaledHeight || 1)
    state.anchor.position.copy(pose.position)
    state.anchor.quaternion.copy(pose.rotation)
    state.anchor.scale.setScalar(pose.scale ?? 1)
    if (state.content) {
      state.content.scale.setScalar(shorter * state.item.size)
      const offset = state.item.offset
      state.content.position.set(shorter * offset.x, shorter * offset.y, shorter * offset.z)
    }
  }

  function modelBounds(root) {
    root.updateMatrixWorld(true)
    const bounds = new THREE.Box3()
    const meshBounds = new THREE.Box3()
    const vertex = new THREE.Vector3()
    root.traverse(mesh => {
      const geometry = mesh.geometry
      if (!geometry) return
      if (!mesh.isSkinnedMesh) {
        if (!geometry.boundingBox) geometry.computeBoundingBox()
        bounds.union(meshBounds.copy(geometry.boundingBox).applyMatrix4(mesh.matrixWorld))
        return
      }

      // Three.js r128 uses undeformed vertices for Box3 and frustum culling.
      // Measure the skinned pose once so the rig and mesh sizes agree.
      mesh.frustumCulled = false
      const positions = geometry.getAttribute('position')
      for (let index = 0; index < positions.count; index++) {
        vertex.fromBufferAttribute(positions, index)
        mesh.boneTransform(index, vertex)
        bounds.expandByPoint(vertex.applyMatrix4(mesh.matrixWorld))
      }
    })
    return bounds
  }

  function prepareModel(gltf, state) {
    const orientation = new THREE.Group()
    const r = state.item.rotationDegrees
    orientation.rotation.set(...['x', 'y', 'z'].map(axis => THREE.MathUtils.degToRad(r[axis])))
    orientation.add(gltf.scene)
    const bounds = modelBounds(orientation)
    if (bounds.isEmpty()) throw new Error('В модели нет видимой геометрии')
    const size = bounds.getSize(new THREE.Vector3())
    const longest = Math.max(size.x, size.y, size.z)
    if (!Number.isFinite(longest) || longest <= 0) throw new Error('Некорректный размер модели')
    const center = bounds.getCenter(new THREE.Vector3())
    const fitted = new THREE.Group()
    fitted.scale.setScalar(1 / longest)
    fitted.position.set(-center.x / longest, -center.y / longest, -bounds.min.z / longest)
    fitted.add(orientation)
    const result = new THREE.Group()
    result.add(fitted)
    const settings = state.item.animation
    if (settings.enabled && gltf.animations?.length) {
      const clip = typeof settings.clip === 'number' ? gltf.animations[settings.clip]
        : THREE.AnimationClip.findByName(gltf.animations, settings.clip)
      if (!clip) console.warn(state.item.label + ': анимация "' + settings.clip + '" не найдена; модель будет статичной')
      else {
        state.mixer = new THREE.AnimationMixer(gltf.scene)
        state.mixer.timeScale = settings.speed
        state.action = state.mixer.clipAction(clip)
        state.action.setLoop(settings.loop ? THREE.LoopRepeat : THREE.LoopOnce, settings.loop ? Infinity : 1)
        state.action.clampWhenFinished = !settings.loop
        state.action.play()
      }
    }
    return result
  }

  let draco = null
  function requestModel(state) {
    if (state.promise) return state.promise
    state.promise = new Promise((resolve, reject) => {
      const loader = new THREE.GLTFLoader()
      if (THREE.DRACOLoader) {
        if (!draco) {
          draco = new THREE.DRACOLoader()
          draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/libs/draco/gltf/')
        }
        loader.setDRACOLoader(draco)
      }
      loader.load(state.item.modelUrl, resolve, undefined, reject)
    }).then(gltf => {
      state.content = prepareModel(gltf, state)
      if (state.anchor) state.anchor.add(state.content)
      applyPose(state)
    }).catch(error => {
      console.error(state.item.label, error)
      state.error = 'Не удалось загрузить ' + state.item.modelUrl + ' (' + (error?.message || String(error)) + ')'
    }).finally(refresh)
    refresh()
    return state.promise
  }

  function found(detail) {
    const state = states.get(detail.name)
    if (!state || fatal) return
    // Копируем числа: движок может переиспользовать объекты detail между кадрами.
    state.pose = {
      position: {x: detail.position.x, y: detail.position.y, z: detail.position.z},
      rotation: {x: detail.rotation.x, y: detail.rotation.y, z: detail.rotation.z, w: detail.rotation.w},
      scale: detail.scale,
      scaledWidth: detail.scaledWidth, scaledHeight: detail.scaledHeight}
    if (!state.tracked) {
      state.tracked = true
      state.lastFound = ++foundSequence
      selected = state
      if (state.item.animation.restartOnFound && state.action) state.action.reset().play()
    }
    applyPose(state)
    requestModel(state)
    refresh()
  }

  function lost(detail) {
    const state = states.get(detail?.name)
    if (!state) return
    state.tracked = false
    if (selected === state) {
      selected = [...states.values()].filter(s => s.tracked)
        .sort((a, b) => b.lastFound - a.lastFound)[0] ?? null
    }
    refresh()
  }

  function lights() {
    const lightConfig = config.lighting
    if (lightConfig.ambient.intensity) {
      scene.add(new THREE.AmbientLight(lightConfig.ambient.color, lightConfig.ambient.intensity))
    }
    if (lightConfig.hemisphere.intensity) {
      const h = lightConfig.hemisphere
      scene.add(new THREE.HemisphereLight(h.skyColor, h.groundColor, h.intensity))
    }
    for (const item of lightConfig.directional) {
      if (!item.intensity) continue
      const light = new THREE.DirectionalLight(item.color, item.intensity)
      light.position.set(item.position.x, item.position.y, item.position.z)
      light.target.position.set(item.target.x, item.target.y, item.target.z)
      scene.add(light, light.target)
    }
  }

  function resize() {
    if (canvas.width !== innerWidth) canvas.width = innerWidth
    if (canvas.height !== innerHeight) canvas.height = innerHeight
  }

  async function start() {
    if (started) return
    started = true
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('Для камеры откройте страницу по HTTPS или через localhost')
      }
      if (!window.THREE?.GLTFLoader) throw new Error('Не загрузились Three.js/GLTFLoader. Проверьте интернет и index.html')
      message('Загрузка настроек…', true)
      config = validate((await json(CONFIG_URL, 'Настройки')).data)
      message('Загрузка маркеров…', true)
      for (const item of config.items) await addTarget(item)
      if (config.preloadModels) {
        message('Загрузка моделей…', true)
        await Promise.all([...states.values()].map(requestModel))
        if ([...states.values()].every(s => s.error)) {
          throw new Error([...states.values()].map(s => s.item.label + ': ' + s.error).join('; '))
        }
      }
      XR8.XrController.configure({disableWorldTracking: true, imageTargetData: [...states.values()].map(s => s.data)})
      XR8.addCameraPipelineModules([
        {
          name: 'museum-canvas-size',
          onAttach() {
            resize()
            window.addEventListener('resize', resize)
            window.visualViewport?.addEventListener('resize', resize)
          },
          onDeviceOrientationChange() { window.requestAnimationFrame(resize) },
          onDetach() {
            window.removeEventListener('resize', resize)
            window.visualViewport?.removeEventListener('resize', resize)
          },
        },
        XR8.GlTextureRenderer.pipelineModule(),
        XR8.Threejs.pipelineModule(),
        XR8.XrController.pipelineModule(),
        {
          name: 'museum-image-models',
          onStart() {
            scene = XR8.Threejs.xrScene().scene
            lights()
            for (const state of states.values()) {
              state.anchor = new THREE.Group()
              state.anchor.name = 'target:' + state.name
              state.anchor.visible = false
              if (state.content) state.anchor.add(state.content)
              scene.add(state.anchor)
              applyPose(state)
            }
            clock = new THREE.Clock()
            refresh()
          },
          onUpdate() {
            const delta = clock ? Math.min(clock.getDelta(), 0.1) : 0
            for (const state of states.values()) {
              if (state.anchor?.visible && state.mixer) state.mixer.update(delta)
            }
          },
          onCameraStatusChange({status: cameraStatus, reason}) {
            if (cameraStatus === 'requesting') message('Разрешите доступ к камере…', true)
            if (cameraStatus === 'hasVideo') message('Подготовка отслеживания…', true)
            if (cameraStatus === 'failed') fail(new Error(reason === 'DENY_CAMERA'
              ? 'Доступ к камере запрещён. Разрешите его в настройках сайта и обновите страницу'
              : 'Не удалось открыть камеру: ' + (reason || 'UNKNOWN')))
          },
          onException: fail,
          listeners: [
            {event: 'reality.imagescanning', process: refresh},
            {event: 'reality.imagefound', process: ({detail}) => found(detail)},
            {event: 'reality.imageupdated', process: ({detail}) => found(detail)},
            {event: 'reality.imagelost', process: ({detail}) => lost(detail)},
          ],
        },
      ])
      message('Запуск камеры…', true)
      resize()
      await XR8.run({canvas, allowedDevices: XR8.XrConfig.device().ANY})
    } catch (error) { fail(error) }
  }

  document.getElementById('xr-engine')?.addEventListener('error', () => fail(new Error('Не загрузился external/xr/xr.js')))
  if (window.XR8) start()
  else window.addEventListener('xrloaded', start, {once: true})
})()
