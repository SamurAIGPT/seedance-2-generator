import config from "@/lib/config";
import { UserService } from "./user";
import { prisma } from "@/lib/prisma";
import { buildMuapiWebhookUrl, createMuapiWebhookToken, hashMuapiWebhookToken } from "./muapi-webhook";

/**
 * Service to manage AI generations and interactions.
 */
export const AIService = {
  /**
   * Calculate credit cost based on duration, quality, and resolution
   */
  getCreditCost(mode, duration, quality, resolution) {
    const isReference = mode === "reference-to-video";
    const is720p = resolution === "720p";
    let rate;
    
    if (isReference) {
      if (is720p) {
        rate = quality === "high" ? 60 : 42;
      } else {
        rate = quality === "high" ? 48 : 36;
      }
    } else {
      if (is720p) {
        rate = quality === "high" ? 50 : 30;
      } else {
        rate = quality === "high" ? 30 : 24;
      }
    }
    
    return Math.ceil(duration * rate);
  },

  /**
   * Execute a generation quest using muapi.ai
   */
  async generate(userId, { mode, prompt, aspect_ratio = "16:9", resolution = "720p", duration = 5, quality = "basic", images_list = [], video_files = [], audio_files = [], customApiKey = null }) {
    const isUsingCustomKey = Boolean(customApiKey && customApiKey.trim().length > 0);
    const cost = isUsingCustomKey ? 0 : this.getCreditCost(mode, duration, quality, resolution);

    if (!isUsingCustomKey && cost > 0) {
      await UserService.deductCredits(userId, cost);
    }

    const apiKey = isUsingCustomKey ? customApiKey.trim() : config.ai.seedance.apiKey;
    if (!apiKey) throw new Error("SEEDANCE_V2_API_KEY is not configured");

    // Map mode to endpoint type
    let type;
    if (mode === "text-to-video") type = "t2v";
    else if (mode === "image-to-video") type = "i2v";
    else if (mode === "reference-to-video") type = "reference";
    
    const endpoint = config.ai.seedance.endpoints[type][resolution];

    if (!endpoint) throw new Error(`Endpoint not found for mode: ${mode} and resolution: ${resolution}`);

    const creationModel = prisma.creation || prisma.Creation;
    if (!creationModel) throw new Error("Creation model is not available");
    const webhookToken = createMuapiWebhookToken();
    const creation = await creationModel.create({
      data: {
        userId,
        prompt,
        aspectRatio: aspect_ratio,
        resolution,
        duration: parseInt(duration),
        quality,
        videoFiles: video_files,
        audioFiles: audio_files,
        inputImages: images_list && images_list.length > 0 ? JSON.stringify(images_list) : null,
        status: "processing",
        webhookTokenHash: hashMuapiWebhookToken(webhookToken),
      }
    });

    const webhookUrl = buildMuapiWebhookUrl(config.auth.webhook_url, webhookToken);
    const submitUrl = `${endpoint}?webhook=${encodeURIComponent(webhookUrl)}`;

    const payload = {
      prompt,
      aspect_ratio,
      duration: parseInt(duration),
      quality
    };

    if (type === "i2v" || type === "reference") {
      payload.images_list = images_list.slice(0, 9);
    }

    if (type === "reference") {
      payload.video_files = video_files.slice(0, 3);
      payload.audio_files = audio_files.slice(0, 3);
    }

    let submissionRejected = false;
    try {
      const submitRes = await fetch(submitUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(payload),
      });

      if (!submitRes.ok) {
        submissionRejected = true;
        const errorText = await submitRes.text();
        throw new Error(`API Submission Failed: ${submitRes.status} ${errorText}`);
      }

      const { request_id } = await submitRes.json();
      if (!request_id) throw new Error("No request_id received from API");

      await creationModel.update({
        where: { id: creation.id },
        data: { requestId: request_id }
      });

      return { request_id };
    } catch (err) {
      if (submissionRejected) {
        const removed = await creationModel.deleteMany({
          where: { id: creation.id, status: "processing", requestId: null },
        });
        if (removed.count === 1 && !isUsingCustomKey && cost > 0) {
          await UserService.addCredits(userId, cost);
        }
      }
      throw err;
    }
  },

  /**
   * Wrapper for edit/reference to video if needed, currently mapping to generate
   */
  async edit(userId, params, customApiKey = null) {
    return this.generate(userId, { ...params, customApiKey });
  },

  /**
   * Check status of a request and save to DB on completion
   */
  async checkStatus(requestId, userId, metadata, customApiKey = null) {
    const creationModel = prisma.creation || prisma.Creation;
    if (!creationModel) return { status: "processing" };

    const creation = await creationModel.findUnique({
      where: { requestId }
    });

    if (!creation) {
      return { status: "processing" };
    }

    if (creation.status === "completed") {
      return { status: "completed", imageUrl: creation.imageUrl };
    }

    if (creation.status === "failed") {
      throw new Error(creation.error || "Generation failed.");
    }

    const isUsingCustomKey = Boolean(customApiKey && customApiKey.trim().length > 0);
    const apiKey = isUsingCustomKey ? customApiKey.trim() : config.ai.seedance.apiKey;
    if (!apiKey) return { status: "processing" };

    try {
      const res = await fetch(`https://api.muapi.ai/api/v1/predictions/${requestId}/result`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        }
      });

      if (res.ok) {
        const result = await res.json();
        const checkStatus = result.status || result.state;
        if (checkStatus === "completed" || checkStatus === "succeeded") {
          const outputs = result.outputs || [];
          const outputUrl = outputs[0] || (typeof result.output === 'string' ? result.output : result.output?.urls?.get);

          if (outputUrl) {
            const updated = await creationModel.update({
              where: { id: creation.id },
              data: {
                status: "completed",
                imageUrl: outputUrl,
              }
            });
            return { status: "completed", imageUrl: updated.imageUrl };
          }
        } else if (checkStatus === "failed") {
          const errorMsg = result.error || "Generation failed";
          await creationModel.update({
            where: { id: creation.id },
            data: {
              status: "failed",
              error: errorMsg,
            }
          });

          // Refund credits if not using custom key
          if (!isUsingCustomKey) {
            const cost = this.getCreditCost(creation.mode, creation.duration || 5, creation.quality || "basic", creation.resolution || "720p");
            await UserService.addCredits(userId, cost);
          }
          throw new Error(errorMsg);
        }
      }
    } catch (e) {
      console.error("Polling error in checkStatus:", e);
    }

    return { status: "processing" };
  }
};
