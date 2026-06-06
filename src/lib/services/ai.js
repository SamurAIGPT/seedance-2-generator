export const AIService = {
  async generate(userId, { mode, prompt, aspect_ratio = "16:9", resolution = "720p", duration = 5, quality = "basic", images_list = [] }) {
    const apiKey = process.env.SEEDANCE_V2_API_KEY;
    if (!apiKey) throw new Error("SEEDANCE_V2_API_KEY is not configured");

    let modelId;
    if (mode === "text-to-video") {
      modelId = quality === "high"
        ? "bytedance/seedance-2.0/text-to-video"
        : "bytedance/seedance-2.0/fast/text-to-video";
    } else if (mode === "image-to-video") {
      modelId = quality === "high"
        ? "bytedance/seedance-2.0/image-to-video"
        : "bytedance/seedance-2.0/fast/image-to-video";
    } else if (mode === "reference-to-video") {
      modelId = quality === "high"
        ? "bytedance/seedance-2.0/reference-to-video"
        : "bytedance/seedance-2.0/fast/reference-to-video";
    }

    const payload = {
      prompt,
      resolution,
      duration: String(duration),
      aspect_ratio,
      generate_audio: false,
    };

    if (mode === "image-to-video" && images_list.length > 0) {
      payload.image_url = images_list[0];
    }

    if (mode === "reference-to-video" && images_list.length > 0) {
      payload.reference_assets = images_list.slice(0, 9).map((url, i) => ({
        type: "image",
        url,
        tag: `Image${i + 1}`,
      }));
    }

    const res = await fetch(`https://fal.run/${modelId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Key ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`FAL API Failed: ${res.status} ${errorText}`);
    }

    const data = await res.json();
    const videoUrl = data?.video?.url;

    if (!videoUrl) throw new Error("No video URL received from FAL API");

    return { 
      request_id: "direct_result",
      video_url: videoUrl
    };
  },

  async checkStatus(requestId) {
    return { status: "processing" };
  }
};
