const toggleButton = document.getElementById("toggleMute");
const loader = document.getElementById("loader");
const startButton = document.getElementById("startSession");
const remoteVideo = document.getElementById("remoteVideo");
const remoteAudio = document.getElementById("remoteAudio");
const mentorIdInput = document.getElementById("mentorIdInput");
const apiKeyInput = document.getElementById("apiKeyInput");
const endSessionBtn = document.getElementById("endSession");
const stopMentorBtn = document.getElementById("stopMentor");
const modeSelect = document.getElementById("mode")
const voiceSelect = document.getElementById("voice")
const sendTextButton = document.getElementById("sendTextButton")
const textArea = document.getElementById("inputText")


function generateGUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0,
      v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}


// --- doNegotiation Method ---
async function doNegotiation({ mentorId, offer, apiKey, mode }) {
  const apiUrl = "https://cogcache-proxy-api.touchcastmaas.dev/v1/realtime";

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      server_type: "hd",
      mentor_id: mentorId,
      offer,
      mode:mode,
      use_green_video: false,
      use_idle_timeout: false,
      prompt:`PROMPT`,
      initial_instructions : "INITIAL INSTRUCTION {For example :Greeting the client}"
    }, (key, value) => {
      if (value === null) {
        return undefined;
      }
      return value;
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to get response from the API");
  }

  const data = await response.json();
  return data;
}

// --- Module: MicrophoneManager ---
function MicrophoneManager() {
  let stream = null;
  let isMuted = false;
  let selectedMicrophone = null;

  const getMicrophones = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices
        .filter((device) => device.kind === "audioinput")
        .map((device) => ({
          ...device,
          deviceId: device.deviceId,
          label: device.label || `Microphone ${device.deviceId}`,
        }));
      return audioInputs;
    } catch (error) {
      console.error("Error fetching microphones:", error);
      return [];
    }
  };

  const connectMicrophone = async () => {
    try {
      const devices = await getMicrophones();
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      selectedMicrophone = devices[0] || null;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true,
        },
      });
      isMuted = false;
      return stream;
    } catch (error) {
      console.error("Error accessing microphone:", error);
      return null;
    }
  };

  const muteMicrophone = (mute) => {
    if (stream) {
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !mute;
      });
      isMuted = mute;
    }
    return isMuted;
  };

  return {
    getMicrophones,
    connectMicrophone,
    muteMicrophone,
    getStream: () => stream,
    isMuted: () => isMuted,
    getSelectedMicrophone: () => selectedMicrophone,
  };
}

// --- Module: WebRTCManager ---
function WebRTCManager() {
  let peerConnection = null;
  let sessionId = null;
  let videoStream = null;
  let audioStream = null;
  let isLoading = false;
  let error = null;
  let audioSender = null;
  let dataChannel = null;

  const config = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
  };

  const handleConnectionStateChange = () => {
    if (peerConnection) {
      console.log("Connection state:", peerConnection.connectionState);
    }
  };

  const handleTrack = (event) => {
    const remoteStream = event.streams[0];
    if (event.track.kind === "video") {
      videoStream = remoteStream;
      if (remoteVideo) {
        remoteVideo.srcObject = videoStream;
      }
    }
    if (event.track.kind === "audio") {
      audioStream = remoteStream;
      if (remoteAudio) {
        remoteAudio.srcObject = audioStream;
        void remoteAudio.play().catch((err) => console.error(err));
      }
    }
  };

  const negotiate = async (mentorId, userMicrophoneStream, apiKey, mode) => {
    // Add an audio transceiver for send/receive.
    audioSender = peerConnection.addTransceiver("audio", {
      direction: "sendrecv",
    });
    if (
      userMicrophoneStream &&
      userMicrophoneStream.getAudioTracks().length > 0
    ) {
      const audioTrack = userMicrophoneStream.getAudioTracks()[0];
      void audioSender.sender.replaceTrack(audioTrack);
    }
    // Add video transceiver for receiving.
    peerConnection.addTransceiver("video", { direction: "recvonly" });

    console.log("Creating offer");
    peerConnection.onnegotiationneeded = async () => {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
    };

    console.log("Waiting for ICE gathering...");
    await new Promise((resolve) => {
      if (peerConnection.iceGatheringState === "complete") {
        resolve();
      } else {
        const checkState = () => {
          if (peerConnection.iceGatheringState === "complete") {
            peerConnection.removeEventListener(
              "icegatheringstatechange",
              checkState
            );
            resolve();
          }
        };
        peerConnection.addEventListener("icegatheringstatechange", checkState);
      }
    });

    const offerLocal = peerConnection.localDescription;

    // Set up track handling.
    peerConnection.ontrack = (event) => {
      console.log("Track received");
      const remoteStream = new MediaStream();
      event.streams[0].getTracks().forEach((track) => {
        remoteStream.addTrack(track);
      });

      const audioElement = new Audio();
      audioElement.srcObject = remoteStream;
      void audioElement.play().catch((err) => console.error(err));
      handleTrack(event);
    };

    try {
      const answerContent = await doNegotiation({
        mentorId,
        offer: offerLocal,
        apiKey,
        mode
      });
      if (peerConnection.signalingState === "have-local-offer") {
        await peerConnection.setRemoteDescription(answerContent.answer);
      } else {
        throw new Error(
          `Invalid signaling state: ${peerConnection.signalingState}`
        );
      }
      sessionId = answerContent.session_id;
    } catch (e) {
      error = e;
      console.error("Negotiation failed:", e);
    }
  };

  const startConnection = async (
    mentorId,
    userMicrophoneStream,
    selectedMicrophone,
    apiKey,
    mode
  ) => {
    isLoading = true;
    try {
      peerConnection = new RTCPeerConnection(config);
      peerConnection.addEventListener(
        "connectionstatechange",
        handleConnectionStateChange
      );
      peerConnection.addEventListener("track", handleTrack);

      dataChannel = peerConnection.createDataChannel("chat", { ordered: true });
      await negotiate(mentorId, userMicrophoneStream, apiKey, mode);
    } catch (e) {
      error = e;
      console.error("Error in WebRTC connection:", e);
    } finally {
      isLoading = false;
    }
  };

  const closeConnection = () => {
    if (dataChannel) {
      dataChannel.close();
    }

    if (peerConnection) {
      peerConnection.getSenders().forEach((sender) => {
        if (sender.track) {
          sender.track.stop();
        }
      });
      peerConnection.removeEventListener(
        "connectionstatechange",
        handleConnectionStateChange
      );
      peerConnection.removeEventListener("track", handleTrack);
      peerConnection.close();
      peerConnection = null;
    }
  };

  const updateAudioTrack = (userMicrophoneStream) => {
    if (peerConnection && audioSender && userMicrophoneStream) {
      const newAudioTrack = userMicrophoneStream.getAudioTracks()[0];
      if (newAudioTrack) {
        audioSender.sender
          .replaceTrack(newAudioTrack)
          .catch((err) => console.error("Failed to replace audio track:", err));
      }
    }
  };

  return {
    startConnection,
    closeConnection,
    updateAudioTrack,
    getDataChannel: () => dataChannel,
    getSessionId: () => sessionId,
    getVideoStream: () => videoStream,
    getAudioStream: () => audioStream,
    getIsLoading: () => isLoading,
    getError: () => error,
  };
}

const microphoneManager = MicrophoneManager();
const webRTCManager = WebRTCManager();

// --- DOM Controls ---
toggleButton.addEventListener("click", () => {
  let currentlyMuted = microphoneManager.isMuted();
  currentlyMuted = microphoneManager.muteMicrophone(!currentlyMuted);
  toggleButton.innerText = currentlyMuted ? "Unmute" : "Mute";
  console.log("Microphone muted:", currentlyMuted);
});
sendTextButton.addEventListener("click", ()=>{
  dataChannel = webRTCManager.getDataChannel()
  if (dataChannel) {
    mode = modeSelect.value;
    textToSend = textArea.value;
    if(textToSend) {
    let data = null;
      if (mode == "tts") {
        data = {
          type: "talk",
          data: {
              talkId: generateGUID(),
              text: textToSend,
          }
        };
      } else {
        data = {
          type: "send_message",
          data: {
              role: "user",
              text: textToSend,
              trigger_response: true
          }
        };
      
        if(data) {
          dataChannel.send(JSON.stringify(data));
        }
      }
    }
  }
})
stopMentorBtn.addEventListener("click", () => {
  const sessionId = webRTCManager.getSessionId();
  const dataChannel = webRTCManager.getDataChannel()
  const data = {
    type: "cancel",
    data: {
      sessionId: sessionId
    },
  };
  dataChannel?.send?.(JSON.stringify(data));
  console.log("stop mentor", data);
});
// modeSelect.addEventListener('change', () => {
//   const isVisible = modeSelect.value == 'tts';
//   voiceSelect.style.display = isVisible ? "block":"none";
// });
startButton.addEventListener("click", async () => {
  const mentorId = mentorIdInput.value.trim();
  const apiKey = apiKeyInput.value.trim();
  const mode = modeSelect.value

  if (!mentorId || !apiKey) {
    alert("Mentor ID and API Key are required.");
    return;
  }
  await microphoneManager.connectMicrophone();
  const micStream = microphoneManager.getStream();
  if (!micStream) {
    console.warn(
      "Microphone stream not available. Please connect your microphone first."
    );
    return;
  }
  // Hide inputs and show loader
  document.getElementById("cardInputs").classList.add("d-none");
  document.getElementById("loader").classList.remove("d-none");

  // Expand card for video
  document.getElementById("cardContent").style.width = "90vw";
  document.getElementById("cardContent").style.height = "85vh";

  await webRTCManager.startConnection(
    mentorId,
    micStream,
    microphoneManager.getSelectedMicrophone(),
    apiKey,
    mode
  );
  console.log("Session ID:", webRTCManager.getSessionId());
});

remoteVideo.addEventListener("playing", function () {
  document.getElementById("loader").classList.add("d-none");
  document.getElementById("videoContainer").classList.remove("d-none");
});

endSessionBtn.addEventListener("click", () => {
  webRTCManager.closeConnection();
  console.log("Connection closed.");

  // Hide video container
  document.getElementById("videoContainer").classList.add("d-none");

  // Reset card size
  document.getElementById("cardContent").removeAttribute("style");

  // Show inputs
  document.getElementById("cardInputs").classList.remove("d-none");

  // Clear input fields
  document.getElementById("mentorIdInput").value = "";
  document.getElementById("apiKeyInput").value = "";
});