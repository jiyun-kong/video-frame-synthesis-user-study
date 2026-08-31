(function () {
  "use strict";

  var DATA_URL = "data/assignments_public.json";
  var PLAYBACK_RATE = 0.85; // 전체 영상 재생속도를 살짝 느리게 (조절하려면 이 값만 변경)

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
    q1: document.getElementById("q1-fieldset"),
    q2: document.getElementById("q2-fieldset"),
    progressFill: document.getElementById("progress-fill"),
    progressText: document.getElementById("progress-text"),
    saveProgressBtn: document.getElementById("btn-save-progress"),
  };

  var allVideos = [els.ref, els.a, els.b];

  var studyData = null;
  var participantId = null;
  var trials = [];       // this participant's trials, ordered by trial_order
  var responses = {};    // token -> {q1_choice, q1_timestamp, q2_choice, q2_timestamp}
  var currentTrial = null;
  var round = 1;          // 1 = Q1 라운드 (GT 비공개, 12개 전부), 2 = Q2 라운드 (GT 있는 trial만)
  var syncTimer = null;
  var playing = false;

  // ---------- storage ----------

  function storageKey(pid) { return "evfra_study_v2_" + pid; }

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
    var rows = [["participant_id", "trial_id", "trial_order", "q1_choice", "q1_timestamp", "q2_choice", "q2_timestamp"]];
    trials.forEach(function (t) {
      var r = responses[t.token];
      if (!r) return;
      rows.push([
        participantId, t.token, String(t.trial_order),
        r.q1_choice || "", r.q1_timestamp || "",
        r.q2_choice || "", r.q2_timestamp || "",
      ]);
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

  // ---------- video engine ----------
  // round 1: Video A/B만 (Reference 없음). round 2: GT 있는 trial만 Reference+A+B.

  function activeVideos() {
    return round === 2 ? [els.ref, els.a, els.b] : [els.a, els.b];
  }

  function applyPlaybackRate() {
    allVideos.forEach(function (v) { v.playbackRate = PLAYBACK_RATE; });
  }

  function setLoadingState(isLoading) {
    els.loading.hidden = !isLoading;
    els.trialArea.hidden = isLoading;
  }

  function updateNextState() {
    if (round === 1) {
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
    if (round === 1) {
      els.q1.disabled = !enabled;
    } else {
      els.q2.disabled = !enabled;
    }
  }

  function updateProgress() {
    var gtTrials = trials.filter(function (t) { return t.has_gt; });
    var q1Done = trials.filter(function (t) { return responses[t.token] && responses[t.token].q1_choice; }).length;
    var q2Done = gtTrials.filter(function (t) { return responses[t.token] && responses[t.token].q2_choice; }).length;
    var totalSteps = trials.length + gtTrials.length;
    var doneSteps = q1Done + q2Done;
    var pct = totalSteps ? Math.round((doneSteps / totalSteps) * 100) : 0;
    els.progressFill.style.width = pct + "%";
    els.progressText.textContent = round === 1
      ? "Q1 (" + q1Done + " / " + trials.length + ")"
      : "Q2 (" + q2Done + " / " + gtTrials.length + ")";
  }

  function setupRoundView() {
    if (round === 1) {
      els.refBlock.hidden = true;
      els.q1.hidden = false;
      els.q2.hidden = true;
    } else {
      els.refBlock.hidden = false;
      els.q1.hidden = true;
      els.q2.hidden = false;
    }
    document.querySelectorAll('input[name="q1"]').forEach(function (r) { r.checked = false; });
    document.querySelectorAll('input[name="q2"]').forEach(function (r) { r.checked = false; });
    updateNextState();
    updateProgress();
  }

  function loadTrial(trial) {
    currentTrial = trial;
    setLoadingState(true);
    setControlsEnabled(false);
    stopSync();
    playing = false;
    setupRoundView();

    var needsRef = round === 2; // round 2는 항상 has_gt=true trial만 방문
    var needed = needsRef ? 3 : 2;
    var readyCount = 0;

    function onReady() {
      readyCount += 1;
      if (readyCount >= needed) {
        applyPlaybackRate();
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
      if (round === 2 && Math.abs(els.ref.currentTime - master) > 0.15) {
        els.ref.currentTime = master;
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
      applyPlaybackRate();
      activeVideos().forEach(function (v) { v.play(); });
      startSync();
      playing = true;
    }
  });

  els.replay.addEventListener("click", function () {
    activeVideos().forEach(function (v) { v.currentTime = 0; });
    applyPlaybackRate();
    activeVideos().forEach(function (v) { v.play(); });
    startSync();
    playing = true;
  });

  document.querySelectorAll('input[name="q1"], input[name="q2"]').forEach(function (r) {
    r.addEventListener("change", updateNextState);
  });

  function recordAnswer() {
    els.next.disabled = true;
    allVideos.forEach(function (v) { v.pause(); });
    stopSync();
    playing = false;

    var now = new Date().toISOString();
    var existing = responses[currentTrial.token] || {};

    if (round === 1) {
      existing.q1_choice = document.querySelector('input[name="q1"]:checked').value;
      existing.q1_timestamp = now;
      if (!currentTrial.has_gt) {
        // GT가 없는 sequence는 2라운드(Q2)에 다시 나오지 않으므로 여기서 바로 확정한다.
        existing.q2_choice = "na";
        existing.q2_timestamp = now;
      }
    } else {
      existing.q2_choice = document.querySelector('input[name="q2"]:checked').value;
      existing.q2_timestamp = now;
    }

    responses[currentTrial.token] = existing;
    saveLocal(participantId);
    updateProgress();
    advance();
  }

  els.next.addEventListener("click", function () {
    if (!currentTrial) return;
    if (round === 1 && !document.querySelector('input[name="q1"]:checked')) return;
    if (round === 2 && !document.querySelector('input[name="q2"]:checked')) return;
    recordAnswer();
  });

  els.saveProgressBtn.addEventListener("click", function () {
    downloadCsv(participantId + "_progress_" + Date.now() + ".csv");
  });

  // ---------- flow control ----------
  // 1부: 12개 trial 전체를 Q1(레퍼런스 비공개)로 먼저 순회한다.
  // 2부: GT가 있는 trial만 다시 순회하며 Q2(레퍼런스 공개)를 묻는다.
  // Q1 응답은 1부에서 이미 확정되어 2부 화면에는 아예 나타나지 않는다(수정 불가).

  function nextRound1Trial() {
    return trials.find(function (t) {
      var r = responses[t.token];
      return !r || !r.q1_choice;
    });
  }

  function nextRound2Trial() {
    return trials.find(function (t) {
      if (!t.has_gt) return false;
      var r = responses[t.token];
      return !r || !r.q2_choice;
    });
  }

  function advance() {
    if (round === 1) {
      var next = nextRound1Trial();
      if (next) { loadTrial(next); return; }
      round = 2;
    }
    var next2 = nextRound2Trial();
    if (next2) { loadTrial(next2); return; }
    finishStudy();
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
    round = nextRound1Trial() ? 1 : 2;
    advance();
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
