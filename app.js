let s3 = null;

document
  .getElementById("authForm")
  .addEventListener("submit", async function (event) {
    event.preventDefault();

    const username = document.getElementById("username").value;
    const password = document.getElementById("password").value;

    try {
      const response = await fetch(
        "https://rshldcc573.execute-api.ap-southeast-2.amazonaws.com/authFunction",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ username, password }),
        }
      );

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          AWS.config.update({
            accessKeyId: "AKIAVWABJOKM3E6SMR6K",
            secretAccessKey: data.privateKey,
            region: "ap-southeast-2",
          });
          AWS.config.credentials.get((err) => {
            if (err) {
              console.error("Credentials refresh error:", err);
            } else {
              console.log("Credentials refreshed successfully");
              s3 = new AWS.S3(); // Instantiate S3 after confirming credentials are refreshed
            }
          });
          s3 = new AWS.S3();
        } else {
          alert("Authentication failed!");
        }
      } else {
        console.error("Error:", response);
        alert("Error: " + response.statusText);
      }
    } catch (error) {
      console.error("Fetch error:", error);
      alert("An error occurred. Please try again.");
    }
  });

const bucketName = "cloud-record-halloween";
let uploadId = null;
let partNumber = 1;
let multipartMap = { Parts: [] };
let mediaRecorder;
let stream;
let recordingStartTime;
let fileKey;
let options = null;
let fileExtension = "";
let uploadPromises = [];
let dataAvailableResolve;
let dataAvailablePromise;

const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const preview = document.getElementById("preview");
const status = document.getElementById("status");

startButton.addEventListener("click", startRecording);
stopButton.addEventListener("click", stopRecording);

window.addEventListener("online", handleOnline);
window.addEventListener("offline", handleOffline);

function handleOnline() {
  console.log("Network connection restored.");
  status.textContent = "Network connection restored.";
  resumeRecording();
}

function handleOffline() {
  console.log("Network connection lost.");
  status.textContent = "Network connection lost. Pausing recording...";
  pauseRecording();
}

function pauseRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.pause();
    console.log("Recording paused due to network loss.");
  }
}

function resumeRecording() {
  if (mediaRecorder && mediaRecorder.state === "paused") {
    mediaRecorder.resume();
    console.log("Recording resumed after network restoration.");
  }
}

async function startRecording() {
  if (!window.MediaRecorder) {
    alert("MediaRecorder API is not supported in your browser.");
    return;
  }

  if (!navigator.onLine) {
    alert("Cannot start recording: No network connection.");
    return;
  }

  if (MediaRecorder.isTypeSupported("video/webm; codecs=vp8,opus")) {
    options = { mimeType: "video/webm; codecs=vp8,opus" };
    fileExtension = "webm";
  } else if (
    MediaRecorder.isTypeSupported('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')
  ) {
    options = { mimeType: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"' };
    fileExtension = "mp4";
  } else if (MediaRecorder.isTypeSupported("video/quicktime")) {
    options = { mimeType: "video/quicktime" };
    fileExtension = "mov";
  } else {
    alert(
      "Your browser does not support any suitable MIME types for recording."
    );
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    preview.srcObject = stream;
  } catch (err) {
    console.error("Error accessing media devices.", err);
    alert("Could not access your camera and microphone.");
    return;
  }

  recordingStartTime = Date.now();
  fileKey = `recordings/${recordingStartTime}.${fileExtension}`;

  dataAvailablePromise = new Promise((resolve) => {
    dataAvailableResolve = resolve;
  });

  try {
    await startMultipartUpload();
  } catch (err) {
    console.error("Failed to start multipart upload:", err);
    alert("Failed to start multipart upload.");
    return;
  }

  mediaRecorder = new MediaRecorder(stream, options);

  // Reset variables
  partNumber = 1;
  multipartMap = { Parts: [] };
  uploadPromises = [];

  mediaRecorder.onpause = function () {
    console.log("MediaRecorder paused.");
    status.textContent = "Recording paused due to network loss.";
  };

  mediaRecorder.onresume = function () {
    console.log("MediaRecorder resumed.");
    status.textContent = "Recording... (resumed after network restoration)";
  };

  mediaRecorder.ondataavailable = function (event) {
    if (event.data.size > 0) {
      const currentPartNumber = partNumber;
      partNumber++;

      const uploadPromise = uploadPart(event.data, currentPartNumber);
      uploadPromises.push(uploadPromise);
    }

    if (mediaRecorder.state === "inactive") {
      dataAvailableResolve();
    }
  };

  mediaRecorder.onerror = function (event) {
    console.error("MediaRecorder error:", event.error);
    alert("An error occurred during recording: " + event.error.name);
  };

  mediaRecorder.onstop = function () {
    stream.getTracks().forEach((track) => track.stop());
    status.textContent = "Stopped recording. Finalizing upload...";

    dataAvailablePromise.then(() => {
      Promise.all(uploadPromises)
        .then(() => {
          console.log("All parts uploaded successfully.");
          completeMultipartUpload();
        })
        .catch((err) => {
          console.error("Error uploading parts:", err);
          status.textContent = "Error uploading parts.";
          abortMultipartUpload();
        });
    });

    startButton.disabled = false;
    stopButton.disabled = true;
  };

  mediaRecorder.start(30000);
  status.textContent = "Recording...";

  startButton.disabled = true;
  stopButton.disabled = false;
}

function stopRecording() {
  mediaRecorder.stop();
}

function startMultipartUpload() {
  return new Promise((resolve, reject) => {
    const params = {
      Bucket: bucketName,
      Key: fileKey,
      ContentType: options.mimeType,
    };

    s3.createMultipartUpload(params, function (err, data) {
      if (err) {
        console.error("Error initiating multipart upload:", err);
        reject(err);
      } else {
        uploadId = data.UploadId;
        console.log("Multipart upload initiated. Upload ID:", uploadId);
        resolve();
      }
    });
  });
}

function uploadPart(blob, currentPartNumber) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = function () {
      const arrayBuffer = reader.result;
      const uint8Array = new Uint8Array(arrayBuffer);

      const params = {
        Body: uint8Array,
        Bucket: bucketName,
        Key: fileKey,
        PartNumber: currentPartNumber,
        UploadId: uploadId,
      };

      s3.uploadPart(params, function (err, data) {
        if (err) {
          console.error(`Error uploading part ${currentPartNumber}:`, err);
          reject(err);
        } else {
          console.log(`Part ${currentPartNumber} uploaded.`);
          multipartMap.Parts.push({
            ETag: data.ETag,
            PartNumber: currentPartNumber,
          });
          resolve();
        }
      });
    };

    reader.onerror = function (err) {
      console.error("FileReader error:", err);
      reject(err);
    };

    reader.readAsArrayBuffer(blob);
  });
}

function completeMultipartUpload() {
  multipartMap.Parts.sort((a, b) => a.PartNumber - b.PartNumber);

  console.log(
    "Completing multipart upload with the following parts:",
    multipartMap.Parts
  );

  const params = {
    Bucket: bucketName,
    Key: fileKey,
    UploadId: uploadId,
    MultipartUpload: multipartMap,
  };

  s3.completeMultipartUpload(params, function (err, data) {
    if (err) {
      console.error("Error completing multipart upload:", err);
      status.textContent = "Error completing upload.";
    } else {
      console.log("Upload completed successfully:", data);
      status.textContent = "Upload completed successfully!";
    }
  });
}

function abortMultipartUpload() {
  const params = {
    Bucket: bucketName,
    Key: fileKey,
    UploadId: uploadId,
  };

  s3.abortMultipartUpload(params, function (err, data) {
    if (err) {
      console.error("Error aborting multipart upload:", err);
    } else {
      console.log("Multipart upload aborted.");
    }
  });
}
