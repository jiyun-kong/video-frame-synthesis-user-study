(function () {
  "use strict";

  var DATA_URL = "data/assignments_public.json";

  var views = ["error", "intro", "study", "complete"];
  function showView(name) {
    views.forEach(function (v) {
      document.getElementById("view-" + v).hidden = (v !== name);
    });
  }

  function showError(msg) {
    document.getElementById("error-message").textContent = msg;
    showView("error");
  }

  var els = {
    loading: document.getElementById("loading-msg"),
    trialArea: document.getElementById("trial-area"),
    refBlock: document.getElementById("ref-block"),
    ref: document.getElementById("video-ref"),
    a: document.getElementById("video-a"),
    b: document.getElementById("video-b"),
    play: document.getElementById("btn-play"),
    replay: document.getElementById("btn-replay"),
    next: document.getElementById("btn-next"),
    phaseHint: document.getElementById("phase-hint"),
    q1: document.getElementById("q1-fieldset"),
    q2: document.getElementById("q2-fieldset"),
    progressFill: document.getElementById("progress-fill"),
    progressText: document.getElementById("progress-text"),
    saveProgressBtn: document.getElementById("btn-save-progress"),
  };

  var HINTS = {
    phase1_gt: "먼저 기준 영상(GT) 없이 Video A/B만 비교합니다. Q1 응답 후 기준 영상이 공개됩니다.\n" +
      "Comparing Video A/B without the reference first; the reference will be revealed after Q1.",
    phase1_nogt: "이 항목은 기준 영상(GT)이 제공되지 않아 Q1만 진행합니다.\n" +
      "No reference video is available for this item, so only Q1 is asked.",
    phase2: "이제 기준 영상(GT)과 비교합니다.\nNow comparing against the reference (GT).",
  };

  var allVideos = [els.ref, els.a, els.b];

  var studyData = null;
  var participantId = null;
  var trials = [];       // this participant's trials, ordered by trial_order
  var responses = {};    // token -> {q1_choice, q2_choice, timestamp}
  var currentTrial = null;
  var phase = 1;
  var syncTimer = null;
  var playing = false;

  // ---------- storage ----------

  function storageKey(pid) { return "evfra_study_v1_" + pid; }

  function loadLocal(pid) {
    try {
      var raw = localStorage.getItem(storageKey(pid));
      if (raw) {
        var parsed = JSON.parse(raw);
        return parsed.responses || {};
      }
    } catch (e) { /* ignore, e.g. private mode */ }
    return {};
  }

  function saveLocal(pid) {
    try {
      localStorage.setItem(storageKey(pid), JSON.stringify({ responses: responses }));
    } catch (e) { /* ignore */ }
  }

  // ---------- csv ----------

  function csvEscape(v) {
    v = String(v == null ? "" : v);
    if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
    return v;
  }

  function buildCsv() {
    var rows = [["participant_id", "trial_id", "trial_order", "q1_choice", "q2_choice", "timestamp"]];
    trials.forEach(function (t) {
      var r = responses[t.token];
      if (!r) return;
      rows.push([participantId, t.token, String(t.trial_order), r.q1_choice, r.q2_choice, r.timestamp]);
    });
    return rows.map(function (row) { return row.map(csvEscape).join(","); }).join("\n") + "\n";
  }

  function downloadCsv(filename) {
    var content = buildCsv();
    var blob = new Blob([content], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---------- phase / video engine (동일 sequence를 두 단계로 나눠 GT 노출 제어) ----------

  function activeVideos() {
    if (phase === 2 && currentTrial && currentTrial.has_gt) {
      return [els.ref, els.a, els.b];
    }
    return [els.a, els.b];
  }

  function setLoadingState(isLoading) {
    els.loading.hidden = !isLoading;
    els.trialArea.hidden = isLoading;
  }

  function updateNextState() {
    if (phase === 1) {
      var q1 = document.querySelector('input[name="q1"]:checked');
      els.next.disabled = !q1;
    } else {
      var q2 = document.querySelector('input[name="q2"]:checked');
      els.next.disabled = !q2;
    }
  }

  function setControlsEnabled(enabled) {
    els.play.disabled = !enabled;
    els.replay.disabled = !enabled;
    els.q1.disabled = !enabled;
  }

  function updateProgress() {
    var completed = Object.keys(responses).length;
    var total = trials.length;
    var pct = total ? Math.round((completed / total) * 100) : 0;
    els.progressFill.style.width = pct + "%";
    els.progressText.textContent = completed + " / " + total + " completed";
  }

  function enterPhase1() {
    phase = 1;
    els.refBlock.hidden = true;
    document.querySelectorAll('input[name="q1"]').forEach(function (r) { r.checked = false; });
    els.q2.hidden = true;
    els.q2.disabled = true;
    document.querySelectorAll('input[name="q2"]').forEach(function (r) { r.checked = false; });
    els.phaseHint.textContent = currentTrial && currentTrial.has_gt ? HINTS.phase1_gt : HINTS.phase1_nogt;
    updateNextState();
  }

  function enterPhase2() {
    phase = 2;
    els.q1.disabled = true; // GT 공개 후 Q1 응답 변경 불가 (bias 방지)
    els.refBlock.hidden = false;
    els.ref.currentTime = els.a.currentTime;
    if (playing) {
      els.ref.play();
    }
    els.q2.hidden = false;
    els.q2.disabled = false;
    els.phaseHint.textContent = HINTS.phase2;
    updateNextState();
  }

  function loadTrial(trial) {
    currentTrial = trial;
    setLoadingState(true);
    setControlsEnabled(false);
    stopSync();
    playing = false;
    enterPhase1();

    var needsRef = !!trial.media.ref;
    var needed = needsRef ? 3 : 2;
    var readyCount = 0;

    function onReady() {
      readyCount += 1;
      if (readyCount >= needed) {
        setLoadingState(false);
        setControlsEnabled(true);
      }
    }

    allVideos.forEach(function (v) {
      v.oncanplaythrough = null;
      v.pause();
      v.removeAttribute("src");
      v.load();
    });

    els.a.src = trial.media.A;
    els.b.src = trial.media.B;
    els.a.oncanplaythrough = onReady;
    els.b.oncanplaythrough = onReady;
    els.a.load();
    els.b.load();

    if (needsRef) {
      els.ref.src = trial.media.ref;
      els.ref.oncanplaythrough = onReady;
      els.ref.load();
    }
  }

  function startSync() {
    stopSync();
    syncTimer = setInterval(function () {
      var master = els.a.currentTime;
      if (Math.abs(els.b.currentTime - master) > 0.15) {
        els.b.currentTime = master;
      }
      if (phase === 2 && currentTrial && currentTrial.has_gt) {
        if (Math.abs(els.ref.currentTime - master) > 0.15) {
          els.ref.currentTime = master;
        }
      }
    }, 500);
  }

  function stopSync() {
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
  }

  allVideos.forEach(function (v) { v.loop = true; });

  els.play.addEventListener("click", function () {
    if (playing) {
      allVideos.forEach(function (v) { v.pause(); });
      stopSync();
      playing = false;
    } else {
      activeVideos().forEach(function (v) { v.play(); });
      startSync();
      playing = true;
    }
  });

  els.replay.addEventListener("click", function () {
    activeVideos().forEach(function (v) { v.currentTime = 0; });
    activeVideos().forEach(function (v) { v.play(); });
    startSync();
    playing = true;
  });

  document.querySelectorAll('input[name="q1"], input[name="q2"]').forEach(function (r) {
    r.addEventListener("change", updateNextState);
  });

  function recordResponse(q1Value, q2Value) {
    els.next.disabled = true;
    allVideos.forEach(function (v) { v.pause(); });
    stopSync();
    playing = false;

    responses[currentTrial.token] = {
      q1_choice: q1Value,
      q2_choice: q2Value,
      timestamp: new Date().toISOString(),
    };
    saveLocal(participantId);
    updateProgress();
    loadNextTrial();
  }

  els.next.addEventListener("click", function () {
    if (!currentTrial) return;

    if (phase === 1) {
      var q1 = document.querySelector('input[name="q1"]:checked');
      if (!q1) return;
      if (currentTrial.has_gt) {
        enterPhase2();
      } else {
        recordResponse(q1.value, "na");
      }
      return;
    }

    var q1Final = document.querySelector('input[name="q1"]:checked');
    var q2 = document.querySelector('input[name="q2"]:checked');
    if (!q1Final || !q2) return;
    recordResponse(q1Final.value, q2.value);
  });

  els.saveProgressBtn.addEventListener("click", function () {
    downloadCsv(participantId + "_progress_" + Date.now() + ".csv");
  });

  // ---------- flow control ----------

  function loadNextTrial() {
    var next = trials.find(function (t) { return !responses[t.token]; });
    if (!next) {
      finishStudy();
      return;
    }
    loadTrial(next);
  }

  function finishStudy() {
    document.getElementById("complete-pid").textContent = "Participant ID: " + participantId;
    document.getElementById("btn-download-final").onclick = function () {
      downloadCsv(participantId + ".csv");
    };
    showView("complete");
  }

  function startStudyFlow() {
    showView("study");
    updateProgress();
    loadNextTrial();
  }

  function tryStart(pidRaw) {
    var pid = (pidRaw || "").trim().toUpperCase();
    if (!pid || !studyData.participants[pid]) {
      var errEl = document.getElementById("pid-error");
      errEl.textContent = "알 수 없는 participant ID입니다: " + (pidRaw || "(empty)");
      errEl.hidden = false;
      showView("intro");
      return;
    }
    participantId = pid;
    trials = studyData.participants[pid].trials;
    responses = loadLocal(pid);
    startStudyFlow();
  }

  function init() {
    var params = new URLSearchParams(window.location.search);
    var urlPid = params.get("participant");

    fetch(DATA_URL)
      .then(function (r) {
        if (!r.ok) throw new Error("bad response");
        return r.json();
      })
      .then(function (data) {
        studyData = data;
        if (urlPid) {
          tryStart(urlPid);
        } else {
          showView("intro");
        }
      })
      .catch(function () {
        showError("연구 데이터를 불러오지 못했습니다. 페이지를 새로고침해보세요. / Failed to load study data. Please refresh.");
      });

    document.getElementById("btn-start").addEventListener("click", function () {
      tryStart(document.getElementById("pid-input").value);
    });
    document.getElementById("pid-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        tryStart(document.getElementById("pid-input").value);
      }
    });
  }

  init();
})();
