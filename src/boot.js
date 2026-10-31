// 地図の描画には WebGL が必要。使えない環境(ブラウザの GPU 無効化など)では、
// 何も映らないまま例外だけが出ないよう、原因と対処を画面に出す。

function hasWebGL() {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

function showWebGLError() {
  document.getElementById('status').hidden = true;
  document.getElementById('no-webgl').hidden = false;
}

if (!hasWebGL()) {
  showWebGLError();
} else {
  // 事前チェックを通っても MapLibre の初期化で失敗することがあるので、読み込み時の例外も拾う
  import('./main.js').catch((err) => {
    console.error(err);
    if (/WebGL/i.test(String(err && err.message))) showWebGLError();
    else throw err;
  });
}
