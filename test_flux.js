require('dotenv').config();
const Replicate = require('replicate');

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

async function main() {
  try {
    const output = await replicate.run("black-forest-labs/flux-schnell", {
      input: {
        prompt: "A beautiful sunny day",
        image: "https://placehold.co/600x400.png",
      }
    });
    console.log("Output URL:", String(output));
  } catch (err) {
    console.log("Error flux-schnell image:", err.message);
  }
}
main();
