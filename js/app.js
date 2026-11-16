// Пути считаются от index.html. Все настройки содержимого находятся здесь.
const AR_CONFIG = {
  targetJson: 'image-targets/custom.json',
  modelUrl: 'assets/model.glb',
  // Максимальный размер модели относительно короткой стороны маркера.
  size: 0.65,
  // Для обычной GLB: Y модели направлен вверх от поверхности маркера.
  rotationDegrees: {x: 90, y: 0, z: 0},
  // Смещение в долях короткой стороны маркера. Z — над поверхностью.
  offset: {x: 0, y: 0, z: 0},
  playAnimation: true,
}

;(function () {
  const canvas = document.getElementById('canvas')
  const overlay = document.getElementById('loading')
  const status = document.getElementById('status')
  let anchor, content, mixer, targetName, clock
  let failed = false

  function message(text, busy = false) {
    if (failed) return
    status.textContent = text
    overlay.hidden = !text
    overlay.classList.toggle('busy', busy)
  }

  function fail(error) {
    console.error(error)
    failed = true
    overlay.hidden = false
    overlay.classList.remove('busy')
    overlay.classList.add('error')
    status.textContent = 'Ошибка: ' + (error?.message || String(error))
  }

  function resize() {
    if (canvas.width !== innerWidth) canvas.width = innerWidth
    if (canvas.height !== innerHeight) canvas.height = innerHeight
  }

  function updatePose(detail) {
    if (!anchor || detail.name !== targetName) return
    const shorter = Math.min(detail.scaledWidth || 1, detail.scaledHeight || 1)
    anchor.position.copy(detail.position)
    anchor.quaternion.copy(detail.rotation)
    anchor.scale.setScalar(detail.scale ?? 1)
    content.scale.setScalar(shorter * AR_CONFIG.size)
    content.position.set(
      shorter * AR_CONFIG.offset.x,
      shorter * AR_CONFIG.offset.y,
      shorter * AR_CONFIG.offset.z
    )
    anchor.visible = true
    message('')
  }

  // Нормализация размера и положения без изменения иерархии GLB/скелета.
  function prepareModel(gltf) {
    const orientation = new THREE.Group()
    orientation.rotation.set(
      THREE.MathUtils.degToRad(AR_CONFIG.rotationDegrees.x),
      THREE.MathUtils.degToRad(AR_CONFIG.rotationDegrees.y),
      THREE.MathUtils.degToRad(AR_CONFIG.rotationDegrees.z)
    )
    orientation.add(gltf.scene)
    orientation.updateMatrixWorld(true)
    const bounds = new THREE.Box3().setFromObject(orientation)
    if (bounds.isEmpty()) throw new Error('В модели нет видимой геометрии')
    const dimensions = bounds.getSize(new THREE.Vector3())
    const longest = Math.max(dimensions.x, dimensions.y, dimensions.z)
    if (!Number.isFinite(longest) || longest <= 0) {
      throw new Error('Некорректный размер модели')
    }
    const center = bounds.getCenter(new THREE.Vector3())
    const fitted = new THREE.Group()
    fitted.scale.setScalar(1 / longest)
    fitted.position.set(-center.x / longest, -center.y / longest, -bounds.min.z / longest)
    fitted.add(orientation)
    const result = new THREE.Group()
    result.add(fitted)
    if (AR_CONFIG.playAnimation && gltf.animations?.length) {
      mixer = new THREE.AnimationMixer(gltf.scene)
      mixer.clipAction(gltf.animations[0]).play()
    }
    return result
  }

  function loadModel() {
    return new Promise((resolve, reject) => {
      const loader = new THREE.GLTFLoader()
      if (THREE.DRACOLoader) {
        const draco = new THREE.DRACOLoader()
        draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/libs/draco/gltf/')
        loader.setDRACOLoader(draco)
      }
      loader.load(AR_CONFIG.modelUrl, resolve, undefined, error => {
        reject(new Error('Не удалось загрузить ' + AR_CONFIG.modelUrl +
          '. Проверьте путь, формат GLB и текстуры. ' + (error?.message || '')))
      })
    })
  }

  async function start() {
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('Для камеры откройте страницу по HTTPS или через localhost')
      }
      if (!window.THREE?.GLTFLoader) {
        throw new Error('Не загрузился Three.js или GLTFLoader. Проверьте интернет и index.html')
      }
      if (!Number.isFinite(AR_CONFIG.size) || AR_CONFIG.size <= 0) {
        throw new Error('AR_CONFIG.size должен быть больше нуля')
      }
      message('Загрузка маркера…', true)
      const targetUrl = new URL(AR_CONFIG.targetJson, document.baseURI)
      const response = await fetch(targetUrl)
      if (!response.ok) throw new Error('Маркер: HTTP ' + response.status + ' — ' + targetUrl.pathname)
      const data = await response.json()
      if (!data.name || !data.imagePath) throw new Error('Некорректный JSON маркера')
      targetName = data.name
      // CLI сохраняет luminanceImage рядом с JSON; абсолютный URL также
      // позволяет запускать проект в подпапке GitHub Pages.
      data.imagePath = data.resources?.luminanceImage
        ? new URL(data.resources.luminanceImage, targetUrl).href
        : new URL(data.imagePath, document.baseURI).href

      message('Загрузка модели…', true)
      content = prepareModel(await loadModel())
      XR8.XrController.configure({disableWorldTracking: true, imageTargetData: [data]})
      XR8.addCameraPipelineModules([
        {
          name: 'custom-canvas-size',
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
          name: 'custom-image-model',
          onStart() {
            const {scene} = XR8.Threejs.xrScene()
            scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 1.2))
            const light = new THREE.DirectionalLight(0xffffff, 0.8)
            light.position.set(1, 2, 3)
            scene.add(light)
            anchor = new THREE.Group()
            anchor.visible = false
            anchor.add(content)
            scene.add(anchor)
            clock = new THREE.Clock()
            message('Наведите камеру на маркер')
          },
          onUpdate() {
            if (clock) {
              const delta = Math.min(clock.getDelta(), 0.1)
              if (anchor?.visible && mixer) mixer.update(delta)
            }
          },
          onCameraStatusChange({status: state, reason}) {
            if (state === 'requesting') message('Разрешите доступ к камере…', true)
            if (state === 'hasVideo') message('Подготовка отслеживания…', true)
            if (state === 'failed') fail(new Error('Не удалось открыть камеру: ' + (reason || 'UNKNOWN')))
          },
          onException: fail,
          listeners: [
            {event: 'reality.imagescanning', process() {
              if (!anchor?.visible) message('Наведите камеру на маркер')
            }},
            {event: 'reality.imagefound', process: ({detail}) => updatePose(detail)},
            {event: 'reality.imageupdated', process: ({detail}) => updatePose(detail)},
            {event: 'reality.imagelost', process({detail}) {
              if (detail?.name && detail.name !== targetName) return
              if (anchor) anchor.visible = false
              message('Наведите камеру на маркер')
            }},
          ],
        },
      ])
      message('Запуск камеры…', true)
      resize()
      XR8.run({canvas, allowedDevices: XR8.XrConfig.device().ANY})
    } catch (error) {
      fail(error)
    }
  }

  if (window.XR8) start()
  else window.addEventListener('xrloaded', start, {once: true})
})()
