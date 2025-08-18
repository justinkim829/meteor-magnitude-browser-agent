# Self-hosting Moondream

Probably the easiest way to deploy Moondream is by hosting it on Modal.

## Set up Modal
1. Create an account at [modal.com](https://modal.com)
2. Run `pip install modal` to install the modal Python package
3. Run `modal setup` to authenticate (if this doesn’t work, try `python -m modal setup`)
> More info: https://modal.com/docs/guide

Modal gives $30 in free credits per month.

## Deploy Moondream

Clone Magnitude and run the `moondream.py` deploy script to automatically download the Moondream server and model weights to a Modal volume and deploy the endpoint:
```sh
git clone https://github.com/magnitudedev/magnitude.git
cd magnitude/infra
modal deploy moondream.py
```

Your Moondream endpoint will then be available at `https://<your-modal-username>--moondream.modal.run/v1`.

Then you can configure `magnitude.config.ts` with this base URL and start running tests powered by your newly deployed Moondream server!

```ts
import { type MagnitudeConfig } from 'magnitude-test';

export default {
    url: "http://localhost:5173",
    executor: {
        provider: 'moondream',
        options: {
            baseUrl: 'https://<your-modal-username>--moondream.modal.run/v1'
        }
    }
} satisfies MagnitudeConfig;
```

Keep in mind there may be some cold start times since Modal automatically scales down containers when not in use.

> This Modal server will be publically accessible. We are working on a better way to make it configurable with a custom API key.

## Customizing Deployment

You may want to customize the modal deployment depending on your needs.

You can modify the `moondream.py` deployment script to fit your needs.

Common options you may want to change:
- `gpu`: GPU configuration. See Modal's [pricing page](https://modal.com/pricing) for details on different available GPUs and their cost. Also see [comparison](#gpu-comparison) below.
- `scaledown_window`: Time in seconds a container will wait to shut down after receiving no requests. If higher, will let you run tests after longer without needing the container to cold-start again.
- `min_containers`: By setting this option you force Modal to keep some number of containers open to handle requests. This means Modal will also bill you for those containers all the time, but eliminates cold-starts.

### GPU Comparison

Here's a breakdown of how quickly different GPUs available on Modal are able to handle typical requests that Magnitude makes to Moondream:

| GPU         | Approximate inference speed per Moondream action | Modal cost per hour |
| ----------- | ------------------------------------------------ | ------------------- |
| H100        | ~200ms                                           | $3.95               |
| A100 (40GB) | ~300ms                                           | $2.10               |
| A10G        | ~500ms                                           | $1.10               |
| T4          | ~800ms                                           | $0.59               |

Since Magnitude needs to wait a bit for the page to stabilize anyway, probably something like the A10G is a good price/performance balance, but any of these work well!
